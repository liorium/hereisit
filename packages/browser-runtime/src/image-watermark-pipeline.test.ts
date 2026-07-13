import { inspectImageHeader } from "@hereisit/image-tool";
import type {
  ImageWatermarkInput,
  ImageWatermarkLogoInput,
  ImageWatermarkSpecV1,
} from "@hereisit/tool-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closePreparedImageWatermarkLogo,
  ImageWatermarkPipelineError,
  type PreparedImageWatermarkLogo,
  prepareImageWatermarkLogo,
  processImageWatermarkPipeline,
  toImageWatermarkErrorPayload,
} from "./image-watermark-pipeline";

const MEBIBYTE = 1024 * 1024;
const MAX_SOURCE_BYTES = 50 * MEBIBYTE;
const MAX_LOGO_BYTES = 10 * MEBIBYTE;
const MAX_OUTPUT_BYTES = 100 * MEBIBYTE;
const PRIVATE_SENTINEL = "GPS_PRIVATE_SENTINEL";

type RasterFormat = "jpeg" | "png" | "webp";

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function writeUint16BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 8) & 0xff;
  bytes[offset + 1] = value & 0xff;
}

function writeUint32BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function writeUint32LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function joinBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(data.byteLength + 12);
  writeUint32BE(chunk, 0, data.byteLength);
  chunk.set(new TextEncoder().encode(type), 4);
  chunk.set(data, 8);
  return chunk;
}

function pngBytes(
  width: number,
  height: number,
  options: { animated?: boolean; privateSentinel?: string } = {},
): Uint8Array {
  const header = new Uint8Array(13);
  writeUint32BE(header, 0, width);
  writeUint32BE(header, 4, height);
  header[8] = 8;
  header[9] = 6;
  const metadata =
    options.privateSentinel === undefined
      ? []
      : [pngChunk("tEXt", new TextEncoder().encode(options.privateSentinel))];
  const animation = options.animated ? [pngChunk("acTL", new Uint8Array(8))] : [];
  return joinBytes(
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    ...metadata,
    ...animation,
    pngChunk("IDAT", Uint8Array.from([0])),
    pngChunk("IEND", new Uint8Array()),
  );
}

function jpegBytes(width: number, height: number): Uint8Array {
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

function webpBytes(width: number, height: number, animated = false): Uint8Array {
  const packed = (width - 1) | ((height - 1) << 14);
  const lossless = new Uint8Array(5);
  lossless[0] = 0x2f;
  writeUint32LE(lossless, 1, packed);
  const chunks = [
    joinBytes(
      new TextEncoder().encode("VP8L"),
      Uint8Array.from([5, 0, 0, 0]),
      lossless,
      Uint8Array.from([0]),
    ),
  ];
  if (animated) {
    chunks.unshift(joinBytes(new TextEncoder().encode("ANIM"), Uint8Array.from([0, 0, 0, 0])));
  }
  const payload = joinBytes(new TextEncoder().encode("WEBP"), ...chunks);
  const output = joinBytes(new TextEncoder().encode("RIFF"), new Uint8Array(4), payload);
  writeUint32LE(output, 4, output.byteLength - 8);
  return output;
}

function isoBox(type: string, data: Uint8Array): Uint8Array {
  const output = new Uint8Array(data.byteLength + 8);
  writeUint32BE(output, 0, output.byteLength);
  output.set(new TextEncoder().encode(type), 4);
  output.set(data, 8);
  return output;
}

function heicBytes(width: number, height: number): Uint8Array {
  const brands = new Uint8Array(16);
  brands.set(new TextEncoder().encode("heic"), 0);
  brands.set(new TextEncoder().encode("mif1"), 8);
  brands.set(new TextEncoder().encode("heic"), 12);
  const spatialExtents = new Uint8Array(12);
  writeUint32BE(spatialExtents, 4, width);
  writeUint32BE(spatialExtents, 8, height);
  return joinBytes(
    isoBox("ftyp", brands),
    isoBox(
      "meta",
      joinBytes(new Uint8Array(4), isoBox("iprp", isoBox("ipco", isoBox("ispe", spatialExtents)))),
    ),
  );
}

function encodedBytes(format: RasterFormat, width: number, height: number): Uint8Array {
  if (format === "jpeg") return jpegBytes(width, height);
  if (format === "webp") return webpBytes(width, height);
  return pngBytes(width, height);
}

function inputFromBytes(
  bytes: Uint8Array,
  overrides: Partial<Omit<ImageWatermarkInput, "bytes">> = {},
): ImageWatermarkInput {
  return {
    name: "source.png",
    mimeHint: "application/octet-stream",
    byteLength: bytes.byteLength,
    bytes: arrayBuffer(bytes),
    ...overrides,
  };
}

function logoInputFromBytes(
  bytes: Uint8Array,
  overrides: Partial<Omit<ImageWatermarkLogoInput, "bytes">> = {},
): ImageWatermarkLogoInput {
  return inputFromBytes(bytes, { name: "logo.png", ...overrides });
}

function textSpec(
  output: ImageWatermarkSpecV1["output"] = { format: "png" },
): ImageWatermarkSpecV1 {
  return {
    version: 1,
    watermark: {
      kind: "text",
      text: "© HereIsIt",
      color: "#111827",
      sizePercent: 12,
    },
    position: "bottom-right",
    marginPercent: 3,
    opacity: 0.55,
    output,
    autoOrient: true,
    metadata: "strip",
  };
}

function logoSpec(
  output: ImageWatermarkSpecV1["output"] = { format: "png" },
): ImageWatermarkSpecV1 {
  return {
    ...textSpec(output),
    watermark: { kind: "logo", widthPercent: 25 },
    marginPercent: 5,
  };
}

type FakeBitmap = Omit<ImageBitmap, "close"> & {
  close: ReturnType<typeof vi.fn<() => void>>;
};

interface CanvasCall {
  name: string;
  args: readonly unknown[];
}

interface FakeBlobLike {
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface RuntimeOptions {
  bitmapSizes?: readonly { width: number; height: number }[];
  bitmapFailure?: unknown;
  onBitmapCreated?: (bitmap: FakeBitmap) => void;
  contextNull?: boolean;
  canvasFailure?: unknown;
  measureText?: (text: string) => Partial<TextMetrics>;
  onDrawImage?: (args: readonly unknown[], callIndex: number) => void;
  convert?: (
    canvas: FakeCanvas,
    options: { type: string; quality?: number },
  ) => Promise<Blob | FakeBlobLike>;
}

class FakeContext {
  readonly calls: CanvasCall[] = [];
  private drawCount = 0;
  private readonly options: RuntimeOptions;
  private _fillStyle: string | CanvasGradient | CanvasPattern = "#000000";
  private _font = "10px sans-serif";
  private _globalAlpha = 1;
  private _textBaseline: CanvasTextBaseline = "alphabetic";
  imageSmoothingEnabled = false;
  imageSmoothingQuality: ImageSmoothingQuality = "low";

  constructor(options: RuntimeOptions) {
    this.options = options;
  }

  set fillStyle(value: string | CanvasGradient | CanvasPattern) {
    this._fillStyle = value;
    this.calls.push({ name: "fillStyle", args: [value] });
  }

  get fillStyle(): string | CanvasGradient | CanvasPattern {
    return this._fillStyle;
  }

  set font(value: string) {
    this._font = value;
    this.calls.push({ name: "font", args: [value] });
  }

  get font(): string {
    return this._font;
  }

  set globalAlpha(value: number) {
    this._globalAlpha = value;
    this.calls.push({ name: "globalAlpha", args: [value] });
  }

  get globalAlpha(): number {
    return this._globalAlpha;
  }

  set textBaseline(value: CanvasTextBaseline) {
    this._textBaseline = value;
    this.calls.push({ name: "textBaseline", args: [value] });
  }

  get textBaseline(): CanvasTextBaseline {
    return this._textBaseline;
  }

  fillRect(...args: readonly unknown[]): void {
    this.calls.push({ name: "fillRect", args });
  }

  drawImage(...args: readonly unknown[]): void {
    this.calls.push({ name: "drawImage", args });
    this.options.onDrawImage?.(args, this.drawCount);
    this.drawCount += 1;
  }

  save(): void {
    this.calls.push({ name: "save", args: [] });
  }

  restore(): void {
    this.calls.push({ name: "restore", args: [] });
  }

  fillText(...args: readonly unknown[]): void {
    this.calls.push({ name: "fillText", args });
  }

  measureText(text: string): TextMetrics {
    this.calls.push({ name: "measureText", args: [text] });
    return {
      width: 0.6,
      actualBoundingBoxAscent: 0.1,
      actualBoundingBoxDescent: 0.02,
      ...this.options.measureText?.(text),
    } as TextMetrics;
  }
}

class FakeCanvas {
  width: number;
  height: number;
  readonly createdWidth: number;
  readonly createdHeight: number;
  readonly context: FakeContext;
  readonly convertCalls: { type: string; quality?: number }[] = [];
  private readonly options: RuntimeOptions;

  constructor(width: number, height: number, options: RuntimeOptions) {
    this.width = width;
    this.height = height;
    this.createdWidth = width;
    this.createdHeight = height;
    this.options = options;
    this.context = new FakeContext(options);
  }

  getContext(): FakeContext | null {
    return this.options.contextNull ? null : this.context;
  }

  async convertToBlob(options: { type: string; quality?: number }): Promise<Blob | FakeBlobLike> {
    this.convertCalls.push(options);
    if (this.options.convert !== undefined) return this.options.convert(this, options);
    const format =
      options.type === "image/jpeg" ? "jpeg" : options.type === "image/webp" ? "webp" : "png";
    return new Blob([arrayBuffer(encodedBytes(format, this.width, this.height))], {
      type: options.type,
    });
  }
}

function installRuntime(options: RuntimeOptions = {}) {
  const bitmaps: FakeBitmap[] = [];
  const decodeCalls: { source: Blob; options: ImageBitmapOptions | undefined }[] = [];
  const canvases: FakeCanvas[] = [];
  let bitmapIndex = 0;

  const createImageBitmapMock = vi.fn(
    async (source: Blob, bitmapOptions?: ImageBitmapOptions): Promise<ImageBitmap> => {
      decodeCalls.push({ source, options: bitmapOptions });
      if (options.bitmapFailure !== undefined) throw options.bitmapFailure;
      const size = options.bitmapSizes?.[bitmapIndex] ?? { width: 1, height: 1 };
      bitmapIndex += 1;
      const bitmap = {
        width: size.width,
        height: size.height,
        close: vi.fn<() => void>(),
      } as unknown as FakeBitmap;
      bitmaps.push(bitmap);
      options.onBitmapCreated?.(bitmap);
      return bitmap;
    },
  );

  vi.stubGlobal("createImageBitmap", createImageBitmapMock);
  class TestOffscreenCanvas extends FakeCanvas {
    constructor(width: number, height: number) {
      if (options.canvasFailure !== undefined) throw options.canvasFailure;
      super(width, height, options);
      canvases.push(this);
    }
  }
  vi.stubGlobal("OffscreenCanvas", TestOffscreenCanvas);

  return { bitmaps, canvases, createImageBitmapMock, decodeCalls };
}

async function rejectedWithCode(
  promise: Promise<unknown>,
  code: InstanceType<typeof ImageWatermarkPipelineError>["code"],
): Promise<ImageWatermarkPipelineError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ImageWatermarkPipelineError);
  expect(caught).toMatchObject({ code, retryable: false });
  expect(caught).not.toHaveProperty("bytes");
  return caught as ImageWatermarkPipelineError;
}

function expectReleased(canvases: readonly FakeCanvas[]): void {
  for (const canvas of canvases) {
    expect(canvas).toMatchObject({ width: 0, height: 0 });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("processImageWatermarkPipeline text composition", () => {
  it("inspects actual bytes, composes text in order, reports progress, and returns exact metadata", async () => {
    const sourceBytes = pngBytes(1, 1, { privateSentinel: PRIVATE_SENTINEL });
    const runtime = installRuntime();
    const report = vi.fn();
    let now = -10;
    vi.spyOn(performance, "now").mockImplementation(() => {
      now += 10;
      return now;
    });

    const result = await processImageWatermarkPipeline(
      inputFromBytes(sourceBytes, {
        name: "holiday.photo.PNG",
        mimeHint: "image/jpeg",
      }),
      textSpec(),
      undefined,
      report,
      new AbortController().signal,
    );

    expect(runtime.createImageBitmapMock).toHaveBeenCalledOnce();
    expect(runtime.decodeCalls[0]?.source).toBeInstanceOf(Blob);
    expect(runtime.decodeCalls[0]?.source.type).toBe("image/png");
    expect(runtime.decodeCalls[0]?.options).toEqual({ imageOrientation: "from-image" });

    expect(runtime.canvases).toHaveLength(1);
    const canvas = runtime.canvases[0] as FakeCanvas;
    expect(canvas).toMatchObject({ createdWidth: 1, createdHeight: 1 });
    const calls = canvas.context.calls;
    expect(calls.filter((call) => call.name === "measureText")).toHaveLength(1);
    expect(calls.filter((call) => call.name === "fillText")).toHaveLength(1);
    expect(calls.filter((call) => call.name === "fillRect")).toHaveLength(0);
    const sourceDraw = calls.findIndex(
      (call) => call.name === "drawImage" && call.args[0] === runtime.bitmaps[0],
    );
    const save = calls.findIndex((call) => call.name === "save");
    const opacity = calls.findIndex((call) => call.name === "globalAlpha" && call.args[0] === 0.55);
    const fillText = calls.findIndex((call) => call.name === "fillText");
    const restore = calls.findIndex((call) => call.name === "restore");
    expect(sourceDraw).toBeGreaterThanOrEqual(0);
    expect(sourceDraw).toBeLessThan(save);
    expect(save).toBeLessThan(opacity);
    expect(opacity).toBeLessThan(fillText);
    expect(fillText).toBeLessThan(restore);
    expect(calls.filter((call) => call.name === "font")).toHaveLength(2);
    expect(calls.filter((call) => call.name === "font")[0]?.args[0]).toMatch(
      /^bold [0-9.]+px sans-serif$/,
    );

    const progress = report.mock.calls as [string, number][];
    expect([...new Set(progress.map(([phase]) => phase))]).toEqual([
      "validating",
      "decoding",
      "compositing",
      "encoding",
      "finalizing",
    ]);
    expect(progress.at(-1)).toEqual(["finalizing", 1]);
    expect(
      progress.every(([, fraction], index) => {
        const previous = progress[index - 1];
        return index === 0 || (previous !== undefined && fraction >= previous[1]);
      }),
    ).toBe(true);

    const expectedOutput = encodedBytes("png", 1, 1);
    expect(result).toEqual({
      bytes: arrayBuffer(expectedOutput),
      suggestedName: "holiday.photo-watermarked-hereisit.png",
      mime: "image/png",
      width: 1,
      height: 1,
      sourceByteLength: sourceBytes.byteLength,
      byteLength: expectedOutput.byteLength,
      format: "png",
      warnings: ["COLOR_PROFILE_NORMALIZED"],
      timing: {
        inspectMs: 10,
        decodeMs: 10,
        compositeMs: 10,
        encodeMs: 10,
        totalMs: 90,
      },
    });
    expect(new TextDecoder().decode(result.bytes)).not.toContain(PRIVATE_SENTINEL);
    expect(inspectImageHeader(result.bytes)).toMatchObject({
      format: "png",
      width: 1,
      height: 1,
    });
    expect(runtime.bitmaps[0]?.close).toHaveBeenCalledOnce();
    expectReleased(runtime.canvases);
  });

  it.each([
    {
      source: jpegBytes(1, 1),
      output: { format: "source", quality: 82 } as const,
      mime: "image/jpeg",
      format: "jpeg",
      filled: true,
      quality: 0.82,
    },
    {
      source: pngBytes(1, 1),
      output: { format: "source", quality: 82 } as const,
      mime: "image/png",
      format: "png",
      filled: false,
      quality: undefined,
    },
    {
      source: webpBytes(1, 1),
      output: { format: "source", quality: 82 } as const,
      mime: "image/webp",
      format: "webp",
      filled: false,
      quality: 0.82,
    },
  ])("resolves $format from structural bytes and applies its alpha and quality policy", async ({
    source,
    output,
    mime,
    format,
    filled,
    quality,
  }) => {
    const runtime = installRuntime();
    const result = await processImageWatermarkPipeline(
      inputFromBytes(source, { mimeHint: "image/definitely-wrong" }),
      textSpec(output),
      undefined,
      vi.fn(),
      new AbortController().signal,
    );
    const canvas = runtime.canvases[0] as FakeCanvas;
    const fillCalls = canvas.context.calls.filter((call) => call.name === "fillRect");
    expect(fillCalls).toHaveLength(filled ? 1 : 0);
    if (filled) {
      const fill = canvas.context.calls.findIndex((call) => call.name === "fillRect");
      const sourceDraw = canvas.context.calls.findIndex(
        (call) => call.name === "drawImage" && call.args[0] === runtime.bitmaps[0],
      );
      expect(
        canvas.context.calls
          .slice(0, fill)
          .some((call) => call.name === "fillStyle" && call.args[0] === "#ffffff"),
      ).toBe(true);
      expect(fill).toBeLessThan(sourceDraw);
    }
    expect(canvas.convertCalls).toEqual([
      quality === undefined ? { type: mime } : { type: mime, quality },
    ]);
    expect(result).toMatchObject({ mime, format });
    expectReleased(runtime.canvases);
  });

  it("reports source-mode HEIC conversion and a white JPEG matte", async () => {
    const runtime = installRuntime();
    const result = await processImageWatermarkPipeline(
      inputFromBytes(heicBytes(1, 1), { name: "phone.heic", mimeHint: "image/png" }),
      textSpec({ format: "source", quality: 90 }),
      undefined,
      vi.fn(),
      new AbortController().signal,
    );

    expect(runtime.decodeCalls[0]?.source.type).toBe("image/heic");
    expect(runtime.canvases[0]?.convertCalls).toEqual([{ type: "image/jpeg", quality: 0.9 }]);
    expect(result).toMatchObject({
      mime: "image/jpeg",
      format: "jpeg",
      warnings: ["SOURCE_FORMAT_CONVERTED", "COLOR_PROFILE_NORMALIZED"],
      suggestedName: "phone-watermarked-hereisit.jpg",
    });
  });
});

describe("prepareImageWatermarkLogo", () => {
  it("accepts a bounded static PNG and closes it only through the explicit cache helper", async () => {
    const runtime = installRuntime({ bitmapSizes: [{ width: 64, height: 32 }] });
    const logo = await prepareImageWatermarkLogo(
      logoInputFromBytes(pngBytes(64, 32), { mimeHint: "image/heic" }),
      new AbortController().signal,
    );

    expect(logo).toEqual({ bitmap: runtime.bitmaps[0], width: 64, height: 32 });
    expect(runtime.decodeCalls[0]?.source.type).toBe("image/png");
    expect(runtime.decodeCalls[0]?.options).toEqual({ imageOrientation: "from-image" });
    expect(runtime.bitmaps[0]?.close).not.toHaveBeenCalled();
    closePreparedImageWatermarkLogo(logo);
    expect(runtime.bitmaps[0]?.close).toHaveBeenCalledOnce();
    expect(() => closePreparedImageWatermarkLogo(undefined)).not.toThrow();
  });

  it.each([
    ["animated PNG", () => pngBytes(1, 1, { animated: true }), "ANIMATED_INPUT"],
    ["animated WebP", () => webpBytes(1, 1, true), "ANIMATED_INPUT"],
    ["HEIC", () => heicBytes(1, 1), "UNSUPPORTED_INPUT"],
    ["oversize side", () => pngBytes(8_193, 1), "DIMENSION_LIMIT"],
    ["oversize pixels", () => pngBytes(4_001, 4_000), "DIMENSION_LIMIT"],
    ["corrupt bytes", () => new TextEncoder().encode("not an image"), "UNSUPPORTED_INPUT"],
  ] as const)("rejects %s before decode", async (_label, createBytes, code) => {
    const runtime = installRuntime();
    await rejectedWithCode(
      prepareImageWatermarkLogo(logoInputFromBytes(createBytes()), new AbortController().signal),
      code,
    );
    expect(runtime.createImageBitmapMock).not.toHaveBeenCalled();
  });

  it("rejects a logo above 10 MiB before structural inspection or decode", async () => {
    const runtime = installRuntime();
    const bytes = new Uint8Array(MAX_LOGO_BYTES + 1);
    await rejectedWithCode(
      prepareImageWatermarkLogo(logoInputFromBytes(bytes), new AbortController().signal),
      "MEMORY_LIMIT",
    );
    expect(runtime.createImageBitmapMock).not.toHaveBeenCalled();
  });

  it.each([
    ["decoded side", { width: 8_193, height: 1 }],
    ["decoded pixels", { width: 4_001, height: 4_000 }],
    ["invalid decoded dimension", { width: 0, height: 1 }],
  ])("checks the %s again and closes the rejected bitmap", async (_label, size) => {
    const runtime = installRuntime({ bitmapSizes: [size] });
    await rejectedWithCode(
      prepareImageWatermarkLogo(logoInputFromBytes(pngBytes(1, 1)), new AbortController().signal),
      "DIMENSION_LIMIT",
    );
    expect(runtime.bitmaps[0]?.close).toHaveBeenCalledOnce();
  });

  it("maps a platform logo decoder failure without exposing input bytes", async () => {
    const runtime = installRuntime({ bitmapFailure: new Error("private decoder detail") });
    const error = await rejectedWithCode(
      prepareImageWatermarkLogo(logoInputFromBytes(pngBytes(1, 1)), new AbortController().signal),
      "DECODE_FAILED",
    );
    expect(error.message).not.toContain("private decoder detail");
    expect(runtime.bitmaps).toHaveLength(0);
  });
});

describe("processImageWatermarkPipeline logo composition", () => {
  it("requires a prepared logo before source decode", async () => {
    const runtime = installRuntime();
    await rejectedWithCode(
      processImageWatermarkPipeline(
        inputFromBytes(pngBytes(1, 1)),
        logoSpec(),
        undefined,
        vi.fn(),
        new AbortController().signal,
      ),
      "LOGO_REQUIRED",
    );
    expect(runtime.createImageBitmapMock).not.toHaveBeenCalled();
  });

  it("draws the cached logo once at the fitted anchor and leaves it open after the item", async () => {
    const runtime = installRuntime({ bitmapSizes: [{ width: 100, height: 80 }] });
    const cachedBitmap = {
      width: 20,
      height: 10,
      close: vi.fn<() => void>(),
    } as unknown as FakeBitmap;
    const logo: PreparedImageWatermarkLogo = {
      bitmap: cachedBitmap,
      width: 20,
      height: 10,
    };

    const result = await processImageWatermarkPipeline(
      inputFromBytes(pngBytes(100, 80)),
      logoSpec(),
      logo,
      vi.fn(),
      new AbortController().signal,
    );

    const logoDraws = runtime.canvases[0]?.context.calls.filter(
      (call) => call.name === "drawImage" && call.args[0] === cachedBitmap,
    );
    expect(logoDraws).toEqual([{ name: "drawImage", args: [cachedBitmap, 71, 63.5, 25, 12.5] }]);
    expect(cachedBitmap.close).not.toHaveBeenCalled();
    expect(runtime.bitmaps[0]?.close).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ width: 100, height: 80 });
    expectReleased(runtime.canvases);
  });
});

describe("processImageWatermarkPipeline validation and postconditions", () => {
  it("rejects an invalid spec before decode", async () => {
    const runtime = installRuntime();
    await rejectedWithCode(
      processImageWatermarkPipeline(
        inputFromBytes(pngBytes(1, 1)),
        { ...textSpec(), opacity: 2 },
        undefined,
        vi.fn(),
        new AbortController().signal,
      ),
      "INVALID_SPEC",
    );
    expect(runtime.createImageBitmapMock).not.toHaveBeenCalled();
  });

  it("rejects an actual byte-length mismatch before decode", async () => {
    const runtime = installRuntime();
    const bytes = pngBytes(1, 1);
    await rejectedWithCode(
      processImageWatermarkPipeline(
        inputFromBytes(bytes, { byteLength: bytes.byteLength + 1 }),
        textSpec(),
        undefined,
        vi.fn(),
        new AbortController().signal,
      ),
      "CORRUPT_INPUT",
    );
    expect(runtime.createImageBitmapMock).not.toHaveBeenCalled();
  });

  it.each([
    ["animated source", pngBytes(1, 1, { animated: true }), "ANIMATED_INPUT"],
    ["corrupt source", new TextEncoder().encode("not an image"), "UNSUPPORTED_INPUT"],
  ] as const)("rejects an %s before decode", async (_label, bytes, code) => {
    const runtime = installRuntime();
    await rejectedWithCode(
      processImageWatermarkPipeline(
        inputFromBytes(bytes),
        textSpec(),
        undefined,
        vi.fn(),
        new AbortController().signal,
      ),
      code,
    );
    expect(runtime.createImageBitmapMock).not.toHaveBeenCalled();
  });

  it.each([
    ["zero bytes", 0],
    ["one byte above 50 MiB", MAX_SOURCE_BYTES + 1],
  ])("rejects %s", async (_label, byteLength) => {
    const runtime = installRuntime();
    const bytes = new Uint8Array(byteLength);
    await rejectedWithCode(
      processImageWatermarkPipeline(
        inputFromBytes(bytes),
        textSpec(),
        undefined,
        vi.fn(),
        new AbortController().signal,
      ),
      "MEMORY_LIMIT",
    );
    expect(runtime.createImageBitmapMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a 16,385px side", pngBytes(16_385, 1)],
    ["exactly 25,000,001 pixels", pngBytes(4_901, 5_101)],
  ])("rejects %s before decode", async (_label, bytes) => {
    expect(
      inspectImageHeader(arrayBuffer(bytes)).width * inspectImageHeader(arrayBuffer(bytes)).height,
    ).toBeGreaterThanOrEqual(_label.includes("25,000,001") ? 25_000_001 : 1);
    const runtime = installRuntime();
    await rejectedWithCode(
      processImageWatermarkPipeline(
        inputFromBytes(bytes),
        textSpec(),
        undefined,
        vi.fn(),
        new AbortController().signal,
      ),
      "DIMENSION_LIMIT",
    );
    expect(runtime.createImageBitmapMock).not.toHaveBeenCalled();
  });

  it.each([
    ["decoded side", { width: 16_385, height: 1 }],
    ["decoded pixels", { width: 4_901, height: 5_101 }],
    ["non-integral decoded geometry", { width: 1.5, height: 1 }],
  ])("checks the %s after decode and closes it", async (_label, size) => {
    const runtime = installRuntime({ bitmapSizes: [size] });
    await rejectedWithCode(
      processImageWatermarkPipeline(
        inputFromBytes(pngBytes(1, 1)),
        textSpec(),
        undefined,
        vi.fn(),
        new AbortController().signal,
      ),
      "DIMENSION_LIMIT",
    );
    expect(runtime.bitmaps[0]?.close).toHaveBeenCalledOnce();
    expect(runtime.canvases).toHaveLength(0);
  });

  it("maps a source decoder failure to DECODE_FAILED", async () => {
    const runtime = installRuntime({ bitmapFailure: new Error("private decoder detail") });
    const error = await rejectedWithCode(
      processImageWatermarkPipeline(
        inputFromBytes(pngBytes(1, 1)),
        textSpec(),
        undefined,
        vi.fn(),
        new AbortController().signal,
      ),
      "DECODE_FAILED",
    );
    expect(error.message).not.toContain("private decoder detail");
    expect(runtime.bitmaps).toHaveLength(0);
  });

  it("releases the source and canvas when no 2D context is available", async () => {
    const runtime = installRuntime({ contextNull: true });
    await rejectedWithCode(
      processImageWatermarkPipeline(
        inputFromBytes(pngBytes(1, 1)),
        textSpec(),
        undefined,
        vi.fn(),
        new AbortController().signal,
      ),
      "MEMORY_LIMIT",
    );
    expect(runtime.bitmaps[0]?.close).toHaveBeenCalledOnce();
    expectReleased(runtime.canvases);
  });

  it("classifies an output-canvas allocation failure as MEMORY_LIMIT", async () => {
    const runtime = installRuntime({ canvasFailure: new RangeError("allocation") });
    await rejectedWithCode(
      processImageWatermarkPipeline(
        inputFromBytes(pngBytes(1, 1)),
        textSpec(),
        undefined,
        vi.fn(),
        new AbortController().signal,
      ),
      "MEMORY_LIMIT",
    );
    expect(runtime.bitmaps[0]?.close).toHaveBeenCalledOnce();
  });

  it("rejects a wrong convertToBlob MIME and releases all item resources", async () => {
    const runtime = installRuntime({
      convert: async (canvas) =>
        new Blob([arrayBuffer(encodedBytes("png", canvas.width, canvas.height))], {
          type: "image/jpeg",
        }),
    });
    await rejectedWithCode(
      processImageWatermarkPipeline(
        inputFromBytes(pngBytes(1, 1)),
        textSpec(),
        undefined,
        vi.fn(),
        new AbortController().signal,
      ),
      "ENCODE_FAILED",
    );
    expect(runtime.bitmaps[0]?.close).toHaveBeenCalledOnce();
    expectReleased(runtime.canvases);
  });

  it("maps a platform encoder failure without leaking its detail", async () => {
    const runtime = installRuntime({
      convert: async () => {
        throw new Error("private encoder detail");
      },
    });
    const error = await rejectedWithCode(
      processImageWatermarkPipeline(
        inputFromBytes(pngBytes(1, 1)),
        textSpec(),
        undefined,
        vi.fn(),
        new AbortController().signal,
      ),
      "ENCODE_FAILED",
    );
    expect(error.message).not.toContain("private encoder detail");
    expect(runtime.bitmaps[0]?.close).toHaveBeenCalledOnce();
    expectReleased(runtime.canvases);
  });

  it("rejects an invalid encoded signature", async () => {
    const runtime = installRuntime({
      convert: async () =>
        new Blob([arrayBuffer(new TextEncoder().encode("not an image"))], {
          type: "image/png",
        }),
    });
    await rejectedWithCode(
      processImageWatermarkPipeline(
        inputFromBytes(pngBytes(1, 1)),
        textSpec(),
        undefined,
        vi.fn(),
        new AbortController().signal,
      ),
      "ENCODE_FAILED",
    );
    expect(runtime.bitmaps[0]?.close).toHaveBeenCalledOnce();
    expectReleased(runtime.canvases);
  });

  it("rejects structurally valid encoded bytes with the wrong dimensions", async () => {
    const runtime = installRuntime({
      convert: async () => new Blob([arrayBuffer(pngBytes(2, 1))], { type: "image/png" }),
    });
    await rejectedWithCode(
      processImageWatermarkPipeline(
        inputFromBytes(pngBytes(1, 1)),
        textSpec(),
        undefined,
        vi.fn(),
        new AbortController().signal,
      ),
      "ENCODE_FAILED",
    );
    expect(runtime.bitmaps[0]?.close).toHaveBeenCalledOnce();
    expectReleased(runtime.canvases);
  });

  it("caps a 100 MiB + 1 encoded result before arrayBuffer()", async () => {
    const read = vi.fn(async () => arrayBuffer(pngBytes(1, 1)));
    const runtime = installRuntime({
      convert: async () => ({ type: "image/png", size: MAX_OUTPUT_BYTES + 1, arrayBuffer: read }),
    });
    await rejectedWithCode(
      processImageWatermarkPipeline(
        inputFromBytes(pngBytes(1, 1)),
        textSpec(),
        undefined,
        vi.fn(),
        new AbortController().signal,
      ),
      "MEMORY_LIMIT",
    );
    expect(read).not.toHaveBeenCalled();
    expect(runtime.bitmaps[0]?.close).toHaveBeenCalledOnce();
    expectReleased(runtime.canvases);
  });

  it("cancels an already-aborted job before decode", async () => {
    const runtime = installRuntime();
    const controller = new AbortController();
    controller.abort();
    await rejectedWithCode(
      processImageWatermarkPipeline(
        inputFromBytes(pngBytes(1, 1)),
        textSpec(),
        undefined,
        vi.fn(),
        controller.signal,
      ),
      "CANCELLED",
    );
    expect(runtime.createImageBitmapMock).not.toHaveBeenCalled();
    expect(runtime.canvases).toHaveLength(0);
  });

  it("closes a decoded bitmap when cancellation lands as the decoder settles", async () => {
    const controller = new AbortController();
    const runtime = installRuntime({
      onBitmapCreated: () => controller.abort(),
    });
    await rejectedWithCode(
      processImageWatermarkPipeline(
        inputFromBytes(pngBytes(1, 1)),
        textSpec(),
        undefined,
        vi.fn(),
        controller.signal,
      ),
      "CANCELLED",
    );
    expect(runtime.bitmaps[0]?.close).toHaveBeenCalledOnce();
    expect(runtime.canvases).toHaveLength(0);
  });

  it("cancels after the source draw and before the watermark draw", async () => {
    const controller = new AbortController();
    const runtime = installRuntime({
      onDrawImage: (_args, callIndex) => {
        if (callIndex === 0) controller.abort();
      },
    });
    await rejectedWithCode(
      processImageWatermarkPipeline(
        inputFromBytes(pngBytes(1, 1)),
        textSpec(),
        undefined,
        vi.fn(),
        controller.signal,
      ),
      "CANCELLED",
    );
    expect(
      runtime.canvases[0]?.context.calls.filter((call) => call.name === "fillText"),
    ).toHaveLength(0);
    expect(runtime.bitmaps[0]?.close).toHaveBeenCalledOnce();
    expectReleased(runtime.canvases);
  });

  it("checks cancellation immediately after encode and exposes no result bytes", async () => {
    const controller = new AbortController();
    const read = vi.fn(async () => arrayBuffer(pngBytes(1, 1)));
    const runtime = installRuntime({
      convert: async () => {
        controller.abort();
        return { type: "image/png", size: pngBytes(1, 1).byteLength, arrayBuffer: read };
      },
    });
    await rejectedWithCode(
      processImageWatermarkPipeline(
        inputFromBytes(pngBytes(1, 1)),
        textSpec(),
        undefined,
        vi.fn(),
        controller.signal,
      ),
      "CANCELLED",
    );
    expect(read).not.toHaveBeenCalled();
    expect(runtime.bitmaps[0]?.close).toHaveBeenCalledOnce();
    expectReleased(runtime.canvases);
  });
});

describe("toImageWatermarkErrorPayload", () => {
  it("maps typed failures and cancellation without exposing private fields", () => {
    expect(
      toImageWatermarkErrorPayload(
        new ImageWatermarkPipelineError("ENCODE_FAILED", "이미지를 인코딩하지 못했어요."),
      ),
    ).toEqual({
      code: "ENCODE_FAILED",
      message: "이미지를 인코딩하지 못했어요.",
      retryable: false,
    });
    expect(toImageWatermarkErrorPayload(new DOMException("private", "AbortError"))).toEqual({
      code: "CANCELLED",
      message: expect.any(String),
      retryable: false,
    });
  });

  it("maps unknown failures to a safe retryable Worker error", () => {
    const payload = toImageWatermarkErrorPayload(new Error("private failure detail"));
    expect(payload).toEqual({
      code: "WORKER_CRASH",
      message: expect.any(String),
      retryable: true,
    });
    expect(payload.message).not.toContain("private failure detail");
    expect(payload).not.toHaveProperty("bytes");
  });
});
