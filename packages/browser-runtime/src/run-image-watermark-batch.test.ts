import type {
  ImageWatermarkBatchItem,
  ImageWatermarkErrorPayload,
  ImageWatermarkResult,
  ImageWatermarkRuntimeEvent,
  ImageWatermarkSpecV1,
  ImageWatermarkWorkerEvent,
} from "@hereisit/tool-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as browserRuntime from "./index";
import {
  runImageWatermarkBatch,
  supportsBrowserImageWatermarkRuntime,
} from "./run-image-watermark-batch";

const MEBIBYTE = 1024 * 1024;
const MAX_SOURCE_BYTES = 50 * MEBIBYTE;
const MAX_BATCH_INPUT_BYTES = 250 * MEBIBYTE;
const MAX_LOGO_BYTES = 10 * MEBIBYTE;
const MAX_RESULT_BYTES = 100 * MEBIBYTE;

const textSpec: ImageWatermarkSpecV1 = {
  version: 1,
  watermark: { kind: "text", text: "HereIsIt", color: "#111827", sizePercent: 12 },
  position: "bottom-right",
  marginPercent: 3,
  opacity: 0.55,
  output: { format: "png" },
  autoOrient: true,
  metadata: "strip",
};

const logoSpec: ImageWatermarkSpecV1 = {
  ...textSpec,
  watermark: { kind: "logo", widthPercent: 20 },
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

interface FakeFileOptions {
  name?: string;
  type?: string;
  size?: number;
  read?: Promise<ArrayBuffer>;
  arrayBuffer?: unknown;
}

function fakeFile(options: FakeFileOptions = {}): {
  file: File;
  arrayBuffer: ReturnType<typeof vi.fn>;
} {
  const size = options.size ?? 4;
  const read = options.read ?? Promise.resolve(new ArrayBuffer(size > MAX_SOURCE_BYTES ? 1 : size));
  const arrayBuffer = vi.fn(() => read);
  return {
    file: {
      name: options.name ?? "photo.png",
      type: options.type ?? "image/png",
      size,
      arrayBuffer: options.arrayBuffer ?? arrayBuffer,
    } as unknown as File,
    arrayBuffer,
  };
}

function item(
  itemId: string,
  file = fakeFile({ name: `${itemId}.png` }).file,
  spec: ImageWatermarkSpecV1 = textSpec,
): ImageWatermarkBatchItem {
  return { itemId, file, spec };
}

interface PostedMessage {
  message: unknown;
  transfer: readonly Transferable[];
}

class StubWorker {
  static instances: StubWorker[] = [];

  readonly messages: PostedMessage[] = [];
  readonly url: URL;
  readonly options: WorkerOptions | undefined;
  terminateCount = 0;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;

  constructor(url: URL, options?: WorkerOptions) {
    this.url = url;
    this.options = options;
    StubWorker.instances.push(this);
  }

  postMessage(message: unknown, transfer: readonly Transferable[] = []): void {
    this.messages.push({ message, transfer });
  }

  terminate(): void {
    this.terminateCount += 1;
  }

  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }
}

class SupportedOffscreenCanvas {
  static instances: SupportedOffscreenCanvas[] = [];

  constructor(
    public width: number,
    public height: number,
  ) {
    SupportedOffscreenCanvas.instances.push(this);
  }

  getContext(contextId: string): object | null {
    return contextId === "2d" ? {} : null;
  }

  async convertToBlob(): Promise<Blob> {
    return new Blob();
  }
}

function installSupportedRuntime(
  options: {
    worker?: unknown;
    deviceMemory?: number;
    omitDeviceMemory?: boolean;
    cores?: number;
  } = {},
): void {
  vi.stubGlobal("Worker", options.worker ?? StubWorker);
  vi.stubGlobal("File", class {});
  vi.stubGlobal("OffscreenCanvas", SupportedOffscreenCanvas);
  vi.stubGlobal("navigator", {
    hardwareConcurrency: options.cores ?? 8,
    ...(options.omitDeviceMemory ? {} : { deviceMemory: options.deviceMemory ?? 8 }),
  });
}

function readyEvent(
  overrides: Partial<Extract<ImageWatermarkWorkerEvent, { type: "ready" }>> = {},
): Extract<ImageWatermarkWorkerEvent, { type: "ready" }> {
  return {
    protocol: 1,
    type: "ready",
    capabilities: {
      decode: ["image/jpeg", "image/png", "image/webp"],
      encode: ["image/jpeg", "image/png", "image/webp"],
      offscreenCanvas: true,
    },
    ...overrides,
  };
}

function isMessageType(
  posted: PostedMessage,
  type: string,
): posted is PostedMessage & { message: { type: string; jobId?: string; assetId?: string } } {
  return (
    typeof posted.message === "object" &&
    posted.message !== null &&
    "type" in posted.message &&
    posted.message.type === type
  );
}

function messagesOfType(worker: StubWorker, type: string): PostedMessage[] {
  return worker.messages.filter((posted) => isMessageType(posted, type));
}

async function waitForMessage(worker: StubWorker, type: string, count = 1): Promise<PostedMessage> {
  await vi.waitFor(() => expect(messagesOfType(worker, type)).toHaveLength(count));
  const posted = messagesOfType(worker, type).at(count - 1);
  if (posted === undefined) throw new Error(`Expected ${type} message ${count}.`);
  return posted;
}

function messageId(posted: PostedMessage, key: "jobId" | "assetId"): string {
  const message = posted.message as Record<PropertyKey, unknown>;
  if (
    typeof posted.message !== "object" ||
    posted.message === null ||
    !(key in message) ||
    typeof message[key] !== "string"
  ) {
    throw new Error(`Expected ${key}.`);
  }
  return message[key];
}

function writeUint32BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function pngBuffer(byteLength: number, width = 2, height = 2): ArrayBuffer {
  if (byteLength < 58) throw new RangeError("A structural PNG fixture needs at least 58 bytes.");
  const bytes = new Uint8Array(byteLength);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  writeUint32BE(bytes, 8, 13);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  writeUint32BE(bytes, 16, width);
  writeUint32BE(bytes, 20, height);
  bytes[24] = 8;
  bytes[25] = 6;

  const imageDataLength = byteLength - 57;
  writeUint32BE(bytes, 33, imageDataLength);
  bytes.set(new TextEncoder().encode("IDAT"), 37);

  const endOffset = byteLength - 12;
  writeUint32BE(bytes, endOffset, 0);
  bytes.set(new TextEncoder().encode("IEND"), endOffset + 4);
  return bytes.buffer;
}

function imageResult(byteLength = 64): ImageWatermarkResult {
  return {
    bytes: pngBuffer(byteLength),
    suggestedName: "photo-watermarked-hereisit.png",
    mime: "image/png",
    width: 2,
    height: 2,
    sourceByteLength: 4,
    byteLength,
    format: "png",
    warnings: [],
    timing: {
      inspectMs: 1,
      decodeMs: 1,
      compositeMs: 1,
      encodeMs: 1,
      totalMs: 4,
    },
  };
}

function emitComplete(
  worker: StubWorker,
  posted: PostedMessage,
  result: ImageWatermarkResult = imageResult(),
): void {
  worker.emit({ protocol: 1, type: "complete", jobId: messageId(posted, "jobId"), result });
}

function emitFailed(
  worker: StubWorker,
  posted: PostedMessage,
  error: ImageWatermarkErrorPayload = {
    code: "DECODE_FAILED",
    message: "이미지를 디코딩하지 못했어요.",
    retryable: false,
  },
): void {
  worker.emit({ protocol: 1, type: "failed", jobId: messageId(posted, "jobId"), error });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  StubWorker.instances = [];
  SupportedOffscreenCanvas.instances = [];
});

describe("supportsBrowserImageWatermarkRuntime", () => {
  it("is published from the browser-runtime root", () => {
    expect(browserRuntime).toHaveProperty(
      "supportsBrowserImageWatermarkRuntime",
      supportsBrowserImageWatermarkRuntime,
    );
    expect(browserRuntime).toHaveProperty("runImageWatermarkBatch", runImageWatermarkBatch);
  });

  it.each([
    "Worker",
    "File",
    "OffscreenCanvas",
  ] as const)("requires the %s browser primitive", (primitive) => {
    installSupportedRuntime();
    vi.stubGlobal(primitive, undefined);

    expect(supportsBrowserImageWatermarkRuntime()).toBe(false);
  });

  it("requires a non-null 2D context and callable convertToBlob and zeros both axes", () => {
    installSupportedRuntime();

    expect(supportsBrowserImageWatermarkRuntime()).toBe(true);
    expect(SupportedOffscreenCanvas.instances).toHaveLength(1);
    expect(SupportedOffscreenCanvas.instances[0]).toMatchObject({ width: 0, height: 0 });

    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        constructor(
          public width: number,
          public height: number,
        ) {}
        getContext(): null {
          return null;
        }
        convertToBlob(): void {}
      },
    );
    expect(supportsBrowserImageWatermarkRuntime()).toBe(false);

    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        constructor(
          public width: number,
          public height: number,
        ) {}
        getContext(): object {
          return {};
        }
      },
    );
    expect(supportsBrowserImageWatermarkRuntime()).toBe(false);
  });

  it("returns false and independently zeros both axes when probing throws", () => {
    let canvas: { width: number; height: number } | undefined;
    installSupportedRuntime();
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        width: number;
        height: number;
        constructor(width: number, height: number) {
          this.width = width;
          this.height = height;
          canvas = this;
        }
        getContext(): never {
          throw new Error("blocked");
        }
      },
    );

    expect(supportsBrowserImageWatermarkRuntime()).toBe(false);
    expect(canvas).toMatchObject({ width: 0, height: 0 });
  });
});

describe("runImageWatermarkBatch validation and readiness", () => {
  it("throws on empty and 101-item batches before Worker construction or reads", () => {
    installSupportedRuntime();
    const source = fakeFile();

    expect(() => runImageWatermarkBatch([])).toThrow(RangeError);
    expect(() =>
      runImageWatermarkBatch(
        Array.from({ length: 101 }, (_, index) => item(`item-${index}`, source.file)),
      ),
    ).toThrow(RangeError);
    expect(source.arrayBuffer).not.toHaveBeenCalled();
    expect(StubWorker.instances).toHaveLength(0);
  });

  it.each([
    0,
    MAX_SOURCE_BYTES + 1,
  ])("rejects a %d-byte source item without reading or assigning it", async (size) => {
    installSupportedRuntime();
    const invalid = fakeFile({ size });
    const handle = runImageWatermarkBatch([item("invalid", invalid.file)]);

    await expect(handle.result).resolves.toMatchObject([
      { itemId: "invalid", status: "rejected", error: { code: "MEMORY_LIMIT" } },
    ]);
    expect(invalid.arrayBuffer).not.toHaveBeenCalled();
    expect(StubWorker.instances).toHaveLength(0);
  });

  it("rejects an invalid spec item without reading or assigning it", async () => {
    installSupportedRuntime();
    const source = fakeFile();
    const handle = runImageWatermarkBatch([
      item("invalid", source.file, { ...textSpec, opacity: 2 }),
    ]);

    await expect(handle.result).resolves.toMatchObject([
      { itemId: "invalid", status: "rejected", error: { code: "INVALID_SPEC" } },
    ]);
    expect(source.arrayBuffer).not.toHaveBeenCalled();
    expect(StubWorker.instances).toHaveLength(0);
  });

  it("rejects every item when total source size exceeds 250MiB", async () => {
    installSupportedRuntime();
    const sources = Array.from({ length: 6 }, (_, index) =>
      fakeFile({ name: `${index}.png`, size: index === 5 ? 1 : MAX_SOURCE_BYTES }),
    );
    const handle = runImageWatermarkBatch(
      sources.map(({ file }, index) => item(`item-${index}`, file)),
    );

    const results = await handle.result;
    expect(results).toHaveLength(6);
    expect(
      results.every((entry) => entry.status === "rejected" && entry.error.code === "MEMORY_LIMIT"),
    ).toBe(true);
    expect(sources.every(({ arrayBuffer }) => arrayBuffer.mock.calls.length === 0)).toBe(true);
    expect(StubWorker.instances).toHaveLength(0);
    expect(sources.reduce((total, { file }) => total + file.size, 0)).toBe(
      MAX_BATCH_INPUT_BYTES + 1,
    );
  });

  it("emits each terminal validation event once when an aggregate limit overrides item validation", async () => {
    installSupportedRuntime();
    const events: ImageWatermarkRuntimeEvent[] = [];
    const sources = [
      fakeFile({ name: "oversize.png", size: MAX_SOURCE_BYTES + 1 }),
      ...Array.from({ length: 4 }, (_, index) =>
        fakeFile({ name: `${index}.png`, size: MAX_SOURCE_BYTES }),
      ),
    ];
    const handle = runImageWatermarkBatch(
      sources.map(({ file }, index) => item(`item-${index}`, file)),
      { onEvent: (event) => events.push(event) },
    );

    await handle.result;
    const completions = events.filter((event) => event.type === "item-complete");
    expect(completions).toHaveLength(sources.length);
    expect(new Set(completions.map((event) => event.itemId)).size).toBe(sources.length);
    expect(events.filter((event) => event.type === "batch-progress")).toHaveLength(sources.length);
  });

  it("rejects logo batches with a missing logo before construction or reads", async () => {
    installSupportedRuntime();
    const source = fakeFile();
    const handle = runImageWatermarkBatch([item("logo", source.file, logoSpec)]);

    await expect(handle.result).resolves.toMatchObject([
      { itemId: "logo", status: "rejected", error: { code: "LOGO_REQUIRED" } },
    ]);
    expect(source.arrayBuffer).not.toHaveBeenCalled();
    expect(StubWorker.instances).toHaveLength(0);
  });

  it.each([
    0,
    MAX_LOGO_BYTES + 1,
  ])("rejects a %d-byte logo before construction or reads", async (size) => {
    installSupportedRuntime();
    const source = fakeFile();
    const logo = fakeFile({ name: "logo.png", size });
    const handle = runImageWatermarkBatch([item("logo", source.file, logoSpec)], {
      logoFile: logo.file,
    });

    await expect(handle.result).resolves.toMatchObject([
      { itemId: "logo", status: "rejected", error: { code: "MEMORY_LIMIT" } },
    ]);
    expect(source.arrayBuffer).not.toHaveBeenCalled();
    expect(logo.arrayBuffer).not.toHaveBeenCalled();
    expect(StubWorker.instances).toHaveLength(0);
  });

  it("rejects an unsupported logo MIME before construction or reads", async () => {
    installSupportedRuntime();
    const source = fakeFile();
    const logo = fakeFile({ name: "logo.svg", type: "image/svg+xml" });
    const handle = runImageWatermarkBatch([item("logo", source.file, logoSpec)], {
      logoFile: logo.file,
    });

    await expect(handle.result).resolves.toMatchObject([
      { itemId: "logo", status: "rejected", error: { code: "UNSUPPORTED_INPUT" } },
    ]);
    expect(source.arrayBuffer).not.toHaveBeenCalled();
    expect(logo.arrayBuffer).not.toHaveBeenCalled();
    expect(StubWorker.instances).toHaveLength(0);
  });

  it("rejects an unsupported runtime before Worker construction or reading", async () => {
    installSupportedRuntime();
    vi.stubGlobal("OffscreenCanvas", undefined);
    const source = fakeFile();
    const handle = runImageWatermarkBatch([item("one", source.file)]);

    await expect(handle.result).resolves.toMatchObject([
      { itemId: "one", status: "rejected", error: { code: "UNSUPPORTED_INPUT" } },
    ]);
    expect(source.arrayBuffer).not.toHaveBeenCalled();
    expect(StubWorker.instances).toHaveLength(0);
  });

  it("constructs two dedicated slots but reads each source only after that slot is ready", async () => {
    installSupportedRuntime();
    const first = fakeFile({ name: "first.png" });
    const second = fakeFile({ name: "second.png" });
    const handle = runImageWatermarkBatch(
      [item("first", first.file), item("second", second.file)],
      { concurrency: 2 },
    );

    expect(StubWorker.instances).toHaveLength(2);
    for (const worker of StubWorker.instances) {
      expect(worker.url.pathname).toMatch(/\/image-watermark\.worker\.ts$/);
      expect(worker.options).toEqual({ type: "module", name: "hereisit-image-watermark-worker" });
    }
    await Promise.resolve();
    expect(first.arrayBuffer).not.toHaveBeenCalled();
    expect(second.arrayBuffer).not.toHaveBeenCalled();

    StubWorker.instances[0]?.emit(readyEvent());
    await vi.waitFor(() => expect(first.arrayBuffer).toHaveBeenCalledOnce());
    expect(second.arrayBuffer).not.toHaveBeenCalled();

    StubWorker.instances[1]?.emit(readyEvent());
    await vi.waitFor(() => expect(second.arrayBuffer).toHaveBeenCalledOnce());
    handle.cancel();
    await handle.result;
  });

  it("reads one logo after readiness, transfers one copy per slot, and gates source reads on matching logo-ready", async () => {
    installSupportedRuntime();
    const first = fakeFile({ name: "first.png" });
    const second = fakeFile({ name: "second.png" });
    const originalLogoBytes = Uint8Array.of(1, 2, 3, 4).buffer;
    const logo = fakeFile({
      name: "logo.png",
      type: "image/png",
      size: originalLogoBytes.byteLength,
      read: Promise.resolve(originalLogoBytes),
    });
    const handle = runImageWatermarkBatch(
      [item("first", first.file, logoSpec), item("second", second.file, logoSpec)],
      { concurrency: 2, logoFile: logo.file },
    );
    const [firstWorker, secondWorker] = StubWorker.instances;
    if (firstWorker === undefined || secondWorker === undefined) throw new Error("Expected slots.");

    await Promise.resolve();
    expect(logo.arrayBuffer).not.toHaveBeenCalled();
    expect(first.arrayBuffer).not.toHaveBeenCalled();
    expect(second.arrayBuffer).not.toHaveBeenCalled();

    firstWorker.emit(readyEvent());
    secondWorker.emit(readyEvent());
    await vi.waitFor(() => expect(logo.arrayBuffer).toHaveBeenCalledOnce());
    const firstConfiguration = await waitForMessage(firstWorker, "configure-logo");
    const secondConfiguration = await waitForMessage(secondWorker, "configure-logo");
    expect(first.arrayBuffer).not.toHaveBeenCalled();
    expect(second.arrayBuffer).not.toHaveBeenCalled();

    const firstAsset = messageId(firstConfiguration, "assetId");
    const secondAsset = messageId(secondConfiguration, "assetId");
    expect(firstAsset).toBe(secondAsset);
    const firstTransfer = firstConfiguration.transfer[0];
    const secondTransfer = secondConfiguration.transfer[0];
    expect(firstConfiguration.transfer).toHaveLength(1);
    expect(secondConfiguration.transfer).toHaveLength(1);
    expect(firstTransfer).toBeInstanceOf(ArrayBuffer);
    expect(secondTransfer).toBeInstanceOf(ArrayBuffer);
    expect(firstTransfer).not.toBe(secondTransfer);
    expect(firstTransfer).not.toBe(originalLogoBytes);
    expect(secondTransfer).not.toBe(originalLogoBytes);

    firstWorker.emit({ protocol: 1, type: "logo-ready", assetId: "foreign-asset" });
    await Promise.resolve();
    expect(first.arrayBuffer).not.toHaveBeenCalled();

    firstWorker.emit({ protocol: 1, type: "logo-ready", assetId: firstAsset });
    await vi.waitFor(() => expect(first.arrayBuffer).toHaveBeenCalledOnce());
    expect(second.arrayBuffer).not.toHaveBeenCalled();

    secondWorker.emit({ protocol: 1, type: "logo-ready", assetId: secondAsset });
    await vi.waitFor(() => expect(second.arrayBuffer).toHaveBeenCalledOnce());
    handle.cancel();
    await handle.result;
  });

  it("ignores a retained UI logo completely for text-only batches", async () => {
    installSupportedRuntime();
    const source = fakeFile();
    const logo = fakeFile({ name: "logo.png", type: "image/png" });
    const handle = runImageWatermarkBatch([item("text", source.file)], {
      concurrency: 1,
      logoFile: logo.file,
    });
    const worker = StubWorker.instances[0];
    if (worker === undefined) throw new Error("Expected a Worker.");

    worker.emit(readyEvent());
    const run = await waitForMessage(worker, "run");
    expect(logo.arrayBuffer).not.toHaveBeenCalled();
    expect(messagesOfType(worker, "configure-logo")).toHaveLength(0);
    expect((run.message as Record<string, unknown>).logoAssetId).toBeUndefined();
    emitComplete(worker, run);
    await expect(handle.result).resolves.toMatchObject([{ status: "fulfilled" }]);
  });
});

describe("runImageWatermarkBatch scheduling and Worker failures", () => {
  it.each([
    {
      label: "unknown memory",
      runtime: { omitDeviceMemory: true },
      concurrency: "auto" as const,
      expected: 1,
    },
    {
      label: "4GiB memory",
      runtime: { deviceMemory: 4 },
      concurrency: "auto" as const,
      expected: 1,
    },
    {
      label: "8GiB memory",
      runtime: { deviceMemory: 8 },
      concurrency: "auto" as const,
      expected: 2,
    },
    { label: "NaN", runtime: { deviceMemory: 8 }, concurrency: Number.NaN, expected: 1 },
    { label: "zero", runtime: { deviceMemory: 8 }, concurrency: 0, expected: 1 },
    { label: "99", runtime: { deviceMemory: 8 }, concurrency: 99, expected: 2 },
  ])("uses $expected slot(s) for $label concurrency", async ({
    runtime,
    concurrency,
    expected,
  }) => {
    installSupportedRuntime(runtime);
    const handle = runImageWatermarkBatch([item("one"), item("two"), item("three")], {
      concurrency,
    });

    expect(StubWorker.instances).toHaveLength(expected);
    handle.cancel();
    await handle.result;
    expect(StubWorker.instances.every((worker) => worker.terminateCount === 1)).toBe(true);
  });

  it("turns synchronous Worker construction failure into rejected item outcomes", async () => {
    class ThrowingWorker extends StubWorker {
      constructor(url: URL, options?: WorkerOptions) {
        super(url, options);
        throw new DOMException("blocked", "SecurityError");
      }
    }
    installSupportedRuntime({ worker: ThrowingWorker });
    const source = fakeFile();

    const handle = runImageWatermarkBatch([item("one", source.file)]);

    await expect(handle.result).resolves.toMatchObject([
      { itemId: "one", status: "rejected", error: { code: "WORKER_CRASH" } },
    ]);
    expect(source.arrayBuffer).not.toHaveBeenCalled();
  });

  it("keeps generated Worker job IDs within the protocol bound for a 128-character item ID", async () => {
    installSupportedRuntime();
    const itemId = "a".repeat(128);
    const handle = runImageWatermarkBatch([item(itemId)], { concurrency: 1 });
    const worker = StubWorker.instances[0];
    if (worker === undefined) throw new Error("Expected a Worker.");
    worker.emit(readyEvent());
    const run = await waitForMessage(worker, "run");

    expect(messageId(run, "jobId").length).toBeLessThanOrEqual(128);
    emitComplete(worker, run);
    await expect(handle.result).resolves.toMatchObject([{ itemId, status: "fulfilled" }]);
  });

  it("replaces a slot that sends a malformed pre-read event", async () => {
    installSupportedRuntime();
    const source = fakeFile();
    const handle = runImageWatermarkBatch([item("one", source.file)], { concurrency: 1 });
    const malformedWorker = StubWorker.instances[0];
    if (malformedWorker === undefined) throw new Error("Expected a Worker.");

    malformedWorker.emit([]);

    await vi.waitFor(() => expect(StubWorker.instances).toHaveLength(2));
    expect(malformedWorker.terminateCount).toBe(1);
    expect(source.arrayBuffer).not.toHaveBeenCalled();
    const replacement = StubWorker.instances[1];
    if (replacement === undefined) throw new Error("Expected replacement.");
    replacement.emit(readyEvent());
    const run = await waitForMessage(replacement, "run");
    emitComplete(replacement, run);
    await expect(handle.result).resolves.toMatchObject([{ itemId: "one", status: "fulfilled" }]);
  });

  it("rejects unsupported Worker capability without reading", async () => {
    installSupportedRuntime();
    const source = fakeFile();
    const handle = runImageWatermarkBatch([item("one", source.file)], { concurrency: 1 });
    const worker = StubWorker.instances[0];
    if (worker === undefined) throw new Error("Expected a Worker.");

    worker.emit(
      readyEvent({
        capabilities: {
          decode: ["image/jpeg", "image/png", "image/webp"],
          encode: ["image/jpeg", "image/png", "image/webp"],
          offscreenCanvas: false,
        },
      }),
    );

    await expect(handle.result).resolves.toMatchObject([
      { itemId: "one", status: "rejected", error: { code: "UNSUPPORTED_INPUT" } },
    ]);
    expect(source.arrayBuffer).not.toHaveBeenCalled();
    expect(worker.terminateCount).toBe(1);
  });

  it("rejects one unreadable source and reuses the slot for the next item", async () => {
    installSupportedRuntime();
    const unreadable = fakeFile({ read: Promise.reject(new Error("read failed")) });
    const next = fakeFile({ name: "next.png" });
    const handle = runImageWatermarkBatch(
      [item("unreadable", unreadable.file), item("next", next.file)],
      { concurrency: 1 },
    );
    const worker = StubWorker.instances[0];
    if (worker === undefined) throw new Error("Expected a Worker.");

    worker.emit(readyEvent());
    const run = await waitForMessage(worker, "run");
    expect(next.arrayBuffer).toHaveBeenCalledOnce();
    emitComplete(worker, run);

    await expect(handle.result).resolves.toMatchObject([
      { itemId: "unreadable", status: "rejected", error: { code: "CORRUPT_INPUT" } },
      { itemId: "next", status: "fulfilled" },
    ]);
  });

  it("contains hostile source-buffer reflection and reuses the slot", async () => {
    installSupportedRuntime();
    const hostileBytes = new Proxy(new ArrayBuffer(4), {
      getPrototypeOf(): never {
        throw new Error("hostile buffer prototype");
      },
    });
    const hostile = fakeFile({ read: Promise.resolve(hostileBytes) });
    const handle = runImageWatermarkBatch([item("hostile", hostile.file), item("next")], {
      concurrency: 1,
    });
    const worker = StubWorker.instances[0];
    if (worker === undefined) throw new Error("Expected a Worker.");
    worker.emit(readyEvent());
    const nextRun = await waitForMessage(worker, "run");
    emitComplete(worker, nextRun);

    await expect(handle.result).resolves.toMatchObject([
      { itemId: "hostile", status: "rejected", error: { code: "CORRUPT_INPUT" } },
      { itemId: "next", status: "fulfilled" },
    ]);
  });

  it("settles a logo configuration failure without reading a source", async () => {
    installSupportedRuntime();
    const source = fakeFile();
    const logo = fakeFile({ name: "logo.png", type: "image/png" });
    const handle = runImageWatermarkBatch([item("logo", source.file, logoSpec)], {
      concurrency: 1,
      logoFile: logo.file,
    });
    const worker = StubWorker.instances[0];
    if (worker === undefined) throw new Error("Expected a Worker.");
    worker.emit(readyEvent());
    const configuration = await waitForMessage(worker, "configure-logo");

    worker.emit({
      protocol: 1,
      type: "logo-failed",
      assetId: messageId(configuration, "assetId"),
      error: { code: "DECODE_FAILED", message: "로고를 디코딩하지 못했어요.", retryable: false },
    });

    await expect(handle.result).resolves.toMatchObject([
      { itemId: "logo", status: "rejected", error: { code: "DECODE_FAILED" } },
    ]);
    expect(source.arrayBuffer).not.toHaveBeenCalled();
    expect(worker.terminateCount).toBe(1);
  });

  it("fails a malformed matching terminal, replaces that slot, and continues queued work", async () => {
    installSupportedRuntime();
    const handle = runImageWatermarkBatch([item("first"), item("second")], { concurrency: 1 });
    const firstWorker = StubWorker.instances[0];
    if (firstWorker === undefined) throw new Error("Expected a Worker.");
    firstWorker.emit(readyEvent());
    const firstRun = await waitForMessage(firstWorker, "run");

    firstWorker.emit({
      protocol: 1,
      type: "complete",
      jobId: messageId(firstRun, "jobId"),
      result: { ...imageResult(), byteLength: 13 },
    });

    await vi.waitFor(() => expect(StubWorker.instances).toHaveLength(2));
    const replacement = StubWorker.instances[1];
    if (replacement === undefined) throw new Error("Expected a replacement Worker.");
    expect(firstWorker.terminateCount).toBe(1);
    replacement.emit(readyEvent());
    const secondRun = await waitForMessage(replacement, "run");
    emitComplete(replacement, secondRun);

    await expect(handle.result).resolves.toMatchObject([
      { itemId: "first", status: "rejected", error: { code: "WORKER_CRASH" } },
      { itemId: "second", status: "fulfilled" },
    ]);
  });

  it("fails closed on an invalid output signature from a matching completion", async () => {
    installSupportedRuntime();
    const handle = runImageWatermarkBatch([item("invalid-output")], { concurrency: 1 });
    const worker = StubWorker.instances[0];
    if (worker === undefined) throw new Error("Expected a Worker.");
    worker.emit(readyEvent());
    const run = await waitForMessage(worker, "run");
    const malformed = imageResult(64);
    malformed.bytes = new ArrayBuffer(64);

    emitComplete(worker, run, malformed);

    await expect(handle.result).resolves.toMatchObject([
      { itemId: "invalid-output", status: "rejected", error: { code: "WORKER_CRASH" } },
    ]);
    expect(worker.terminateCount).toBe(1);
  });

  it("replaces a slot after a malformed matching logo acknowledgement", async () => {
    installSupportedRuntime();
    const source = fakeFile();
    const logo = fakeFile({ name: "logo.png", type: "image/png" });
    const handle = runImageWatermarkBatch([item("logo", source.file, logoSpec)], {
      concurrency: 1,
      logoFile: logo.file,
    });
    const malformedWorker = StubWorker.instances[0];
    if (malformedWorker === undefined) throw new Error("Expected a Worker.");
    malformedWorker.emit(readyEvent());
    const configuration = await waitForMessage(malformedWorker, "configure-logo");

    malformedWorker.emit({
      protocol: 1,
      type: "logo-ready",
      assetId: messageId(configuration, "assetId"),
      privateBytes: "must-not-cross",
    });

    await vi.waitFor(() => expect(StubWorker.instances).toHaveLength(2));
    expect(malformedWorker.terminateCount).toBe(1);
    expect(source.arrayBuffer).not.toHaveBeenCalled();
    const replacement = StubWorker.instances[1];
    if (replacement === undefined) throw new Error("Expected a replacement.");
    replacement.emit(readyEvent());
    const replacementConfiguration = await waitForMessage(replacement, "configure-logo");
    replacement.emit({
      protocol: 1,
      type: "logo-ready",
      assetId: messageId(replacementConfiguration, "assetId"),
    });
    const run = await waitForMessage(replacement, "run");
    emitComplete(replacement, run);

    await expect(handle.result).resolves.toMatchObject([{ itemId: "logo", status: "fulfilled" }]);
    expect(logo.arrayBuffer).toHaveBeenCalledOnce();
  });

  it("ignores a foreign completion without touching its hostile result payload", async () => {
    installSupportedRuntime();
    const handle = runImageWatermarkBatch([item("one")], { concurrency: 1 });
    const worker = StubWorker.instances[0];
    if (worker === undefined) throw new Error("Expected a Worker.");
    worker.emit(readyEvent());
    const run = await waitForMessage(worker, "run");
    const foreign = {
      protocol: 1,
      type: "complete",
      jobId: "foreign-job",
    } as Record<PropertyKey, unknown>;
    const resultGetter = vi.fn<() => never>(() => {
      throw new Error("foreign result must not be decoded");
    });
    Object.defineProperty(foreign, "result", {
      configurable: true,
      enumerable: true,
      get: resultGetter,
    });

    expect(() => worker.emit(foreign)).not.toThrow();
    expect(resultGetter).not.toHaveBeenCalled();
    emitComplete(worker, run);
    await expect(handle.result).resolves.toMatchObject([{ itemId: "one", status: "fulfilled" }]);
  });

  it("filters a foreign job ID before touching a hostile event type", async () => {
    installSupportedRuntime();
    const handle = runImageWatermarkBatch([item("one")], { concurrency: 1 });
    const worker = StubWorker.instances[0];
    if (worker === undefined) throw new Error("Expected a Worker.");
    worker.emit(readyEvent());
    const run = await waitForMessage(worker, "run");
    const foreign = { protocol: 1, jobId: "foreign-job" } as Record<PropertyKey, unknown>;
    const typeGetter = vi.fn<() => never>(() => {
      throw new Error("foreign type must not be decoded");
    });
    Object.defineProperty(foreign, "type", {
      configurable: true,
      enumerable: true,
      get: typeGetter,
    });

    expect(() => worker.emit(foreign)).not.toThrow();
    expect(typeGetter).not.toHaveBeenCalled();
    emitComplete(worker, run);
    await expect(handle.result).resolves.toMatchObject([{ itemId: "one", status: "fulfilled" }]);
  });

  it("ignores foreign and stale events and filters regressing progress sequences", async () => {
    installSupportedRuntime();
    const events: ImageWatermarkRuntimeEvent[] = [];
    const handle = runImageWatermarkBatch([item("first"), item("second")], {
      concurrency: 1,
      onEvent: (event) => events.push(event),
    });
    const worker = StubWorker.instances[0];
    if (worker === undefined) throw new Error("Expected a Worker.");
    worker.emit(readyEvent());
    const firstRun = await waitForMessage(worker, "run");
    const firstJobId = messageId(firstRun, "jobId");

    worker.emit({
      protocol: 1,
      type: "progress",
      jobId: "foreign-job",
      sequence: 0,
      phase: "validating",
      fraction: 0.1,
    });
    worker.emit({
      protocol: 1,
      type: "progress",
      jobId: firstJobId,
      sequence: 1,
      phase: "decoding",
      fraction: 0.4,
    });
    worker.emit({
      protocol: 1,
      type: "progress",
      jobId: firstJobId,
      sequence: 0,
      phase: "validating",
      fraction: 0.2,
    });
    emitComplete(worker, firstRun);
    const secondRun = await waitForMessage(worker, "run", 2);

    worker.emit({
      protocol: 1,
      type: "complete",
      jobId: firstJobId,
      result: imageResult(),
    });
    await Promise.resolve();
    expect(messagesOfType(worker, "run")).toHaveLength(2);
    emitComplete(worker, secondRun);

    await expect(handle.result).resolves.toMatchObject([
      { itemId: "first", status: "fulfilled" },
      { itemId: "second", status: "fulfilled" },
    ]);
    expect(events.filter((event) => event.type === "item-progress")).toEqual([
      { type: "item-progress", itemId: "first", phase: "decoding", fraction: 0.4 },
    ]);
  });

  it("survives observer exceptions without changing item settlement", async () => {
    installSupportedRuntime();
    const handle = runImageWatermarkBatch([item("one")], {
      concurrency: 1,
      onEvent: () => {
        throw new Error("observer failed");
      },
    });
    const worker = StubWorker.instances[0];
    if (worker === undefined) throw new Error("Expected a Worker.");
    worker.emit(readyEvent());
    const run = await waitForMessage(worker, "run");
    worker.emit({
      protocol: 1,
      type: "progress",
      jobId: messageId(run, "jobId"),
      sequence: 0,
      phase: "validating",
      fraction: 0.02,
    });
    emitComplete(worker, run);

    await expect(handle.result).resolves.toMatchObject([{ itemId: "one", status: "fulfilled" }]);
  });

  it.each([
    "error",
    "messageerror",
  ] as const)("replaces a crashed slot after Worker %s and processes queued work", async (eventType) => {
    installSupportedRuntime();
    const handle = runImageWatermarkBatch([item("first"), item("second")], { concurrency: 1 });
    const crashed = StubWorker.instances[0];
    if (crashed === undefined) throw new Error("Expected a Worker.");
    crashed.emit(readyEvent());
    await waitForMessage(crashed, "run");

    if (eventType === "error") {
      crashed.onerror?.(new Error("crash"));
    } else {
      crashed.onmessageerror?.({ data: undefined } as MessageEvent<unknown>);
    }

    await vi.waitFor(() => expect(StubWorker.instances).toHaveLength(2));
    const replacement = StubWorker.instances[1];
    if (replacement === undefined) throw new Error("Expected replacement.");
    replacement.emit(readyEvent());
    const run = await waitForMessage(replacement, "run");
    emitComplete(replacement, run);

    await expect(handle.result).resolves.toMatchObject([
      { itemId: "first", status: "rejected", error: { code: "WORKER_CRASH" } },
      { itemId: "second", status: "fulfilled" },
    ]);
    expect(crashed.terminateCount).toBe(1);
  });

  it("terminates a timed-out slot and replaces it only while queued work remains", async () => {
    vi.useFakeTimers();
    installSupportedRuntime();
    const handle = runImageWatermarkBatch([item("first"), item("second")], { concurrency: 1 });
    const timedOut = StubWorker.instances[0];
    if (timedOut === undefined) throw new Error("Expected a Worker.");
    timedOut.emit(readyEvent());
    await Promise.resolve();
    expect(messagesOfType(timedOut, "run")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(179_999);
    expect(StubWorker.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(timedOut.terminateCount).toBe(1);
    expect(StubWorker.instances).toHaveLength(2);
    const replacement = StubWorker.instances[1];
    if (replacement === undefined) throw new Error("Expected replacement.");
    replacement.emit(readyEvent());
    const run = await waitForMessage(replacement, "run");
    emitComplete(replacement, run);

    await expect(handle.result).resolves.toMatchObject([
      { itemId: "first", status: "rejected", error: { code: "WORKER_CRASH" } },
      { itemId: "second", status: "fulfilled" },
    ]);
  });

  it("configures a replacement from the one retained logo read after a crash", async () => {
    installSupportedRuntime();
    const logo = fakeFile({ name: "logo.png", type: "image/png" });
    const handle = runImageWatermarkBatch(
      [item("first", undefined, logoSpec), item("second", undefined, logoSpec)],
      { concurrency: 1, logoFile: logo.file },
    );
    const crashed = StubWorker.instances[0];
    if (crashed === undefined) throw new Error("Expected a Worker.");
    crashed.emit(readyEvent());
    const firstConfiguration = await waitForMessage(crashed, "configure-logo");
    crashed.emit({
      protocol: 1,
      type: "logo-ready",
      assetId: messageId(firstConfiguration, "assetId"),
    });
    await waitForMessage(crashed, "run");
    crashed.onerror?.(new Error("crash"));

    await vi.waitFor(() => expect(StubWorker.instances).toHaveLength(2));
    const replacement = StubWorker.instances[1];
    if (replacement === undefined) throw new Error("Expected replacement.");
    replacement.emit(readyEvent());
    const replacementConfiguration = await waitForMessage(replacement, "configure-logo");
    expect(logo.arrayBuffer).toHaveBeenCalledOnce();
    replacement.emit({
      protocol: 1,
      type: "logo-ready",
      assetId: messageId(replacementConfiguration, "assetId"),
    });
    const secondRun = await waitForMessage(replacement, "run");
    emitComplete(replacement, secondRun);

    await expect(handle.result).resolves.toMatchObject([
      { itemId: "first", status: "rejected", error: { code: "WORKER_CRASH" } },
      { itemId: "second", status: "fulfilled" },
    ]);
  });
});

describe("runImageWatermarkBatch result budgets and ordering", () => {
  it("keeps returned results in input order when two slots complete out of order", async () => {
    installSupportedRuntime();
    const completionOrder: string[] = [];
    const handle = runImageWatermarkBatch([item("first"), item("second")], {
      concurrency: 2,
      onEvent: (event) => {
        if (event.type === "item-complete") completionOrder.push(event.itemId);
      },
    });
    const [firstWorker, secondWorker] = StubWorker.instances;
    if (firstWorker === undefined || secondWorker === undefined) throw new Error("Expected slots.");
    firstWorker.emit(readyEvent());
    secondWorker.emit(readyEvent());
    const firstRun = await waitForMessage(firstWorker, "run");
    const secondRun = await waitForMessage(secondWorker, "run");

    emitComplete(secondWorker, secondRun);
    emitComplete(firstWorker, firstRun);

    await expect(handle.result).resolves.toMatchObject([
      { itemId: "first", status: "fulfilled" },
      { itemId: "second", status: "fulfilled" },
    ]);
    expect(completionOrder).toEqual(["second", "first"]);
    expect(firstWorker.terminateCount).toBe(1);
    expect(secondWorker.terminateCount).toBe(1);
  });

  it("preserves a Worker-reported item failure alongside another success", async () => {
    installSupportedRuntime();
    const handle = runImageWatermarkBatch([item("failed"), item("complete")], { concurrency: 1 });
    const worker = StubWorker.instances[0];
    if (worker === undefined) throw new Error("Expected a Worker.");
    worker.emit(readyEvent());
    const failedRun = await waitForMessage(worker, "run");
    emitFailed(worker, failedRun);
    const completeRun = await waitForMessage(worker, "run", 2);
    emitComplete(worker, completeRun);

    await expect(handle.result).resolves.toMatchObject([
      { itemId: "failed", status: "rejected", error: { code: "DECODE_FAILED" } },
      { itemId: "complete", status: "fulfilled" },
    ]);
  });

  it("accepts an exact 100MiB result", async () => {
    installSupportedRuntime();
    const handle = runImageWatermarkBatch([item("exact")], { concurrency: 1 });
    const worker = StubWorker.instances[0];
    if (worker === undefined) throw new Error("Expected a Worker.");
    worker.emit(readyEvent());
    const run = await waitForMessage(worker, "run");

    emitComplete(worker, run, imageResult(MAX_RESULT_BYTES));

    await expect(handle.result).resolves.toMatchObject([
      { itemId: "exact", status: "fulfilled", value: { byteLength: MAX_RESULT_BYTES } },
    ]);
  });

  it("rejects a 100MiB+1 result as an item memory limit without exposing bytes", async () => {
    installSupportedRuntime();
    const handle = runImageWatermarkBatch([item("oversize")], { concurrency: 1 });
    const worker = StubWorker.instances[0];
    if (worker === undefined) throw new Error("Expected a Worker.");
    worker.emit(readyEvent());
    const run = await waitForMessage(worker, "run");

    emitComplete(worker, run, imageResult(MAX_RESULT_BYTES + 1));

    const results = await handle.result;
    expect(results).toMatchObject([
      { itemId: "oversize", status: "rejected", error: { code: "MEMORY_LIMIT" } },
    ]);
    expect(results[0]).not.toHaveProperty("value");
  });

  it("accepts exactly 500MiB retained, then rejects the item that would cross the batch limit", async () => {
    installSupportedRuntime({ omitDeviceMemory: true });
    const handle = runImageWatermarkBatch(
      Array.from({ length: 6 }, (_, index) => item(`item-${index + 1}`)),
      { concurrency: 1 },
    );
    const worker = StubWorker.instances[0];
    if (worker === undefined) throw new Error("Expected a Worker.");
    worker.emit(readyEvent());

    for (let index = 0; index < 5; index += 1) {
      const run = await waitForMessage(worker, "run", index + 1);
      emitComplete(worker, run, imageResult(MAX_RESULT_BYTES));
    }
    const crossingRun = await waitForMessage(worker, "run", 6);
    emitComplete(worker, crossingRun, imageResult(64));

    const results = await handle.result;
    expect(results.slice(0, 5).every((entry) => entry.status === "fulfilled")).toBe(true);
    expect(results[5]).toMatchObject({
      itemId: "item-6",
      status: "rejected",
      error: { code: "MEMORY_LIMIT" },
    });
    if (results[5]?.status === "rejected") expect(results[5]).not.toHaveProperty("value");
  });
});

describe("runImageWatermarkBatch cancellation", () => {
  it("cancels before readiness, terminates every slot once, and ignores hostile late events", async () => {
    installSupportedRuntime();
    const first = fakeFile({ name: "first.png" });
    const second = fakeFile({ name: "second.png" });
    const handle = runImageWatermarkBatch(
      [item("first", first.file), item("second", second.file)],
      { concurrency: 2 },
    );
    const workers = [...StubWorker.instances];
    handle.cancel();
    handle.cancel();

    await expect(handle.result).resolves.toEqual([
      { itemId: "first", status: "cancelled" },
      { itemId: "second", status: "cancelled" },
    ]);
    expect(workers.every((worker) => worker.terminateCount === 1)).toBe(true);
    const hostile = Object.defineProperty({}, "type", {
      get(): never {
        throw new Error("late hostile getter");
      },
    });
    expect(() => workers[0]?.emit(hostile)).not.toThrow();
    workers[1]?.emit(readyEvent());
    await Promise.resolve();
    expect(first.arrayBuffer).not.toHaveBeenCalled();
    expect(second.arrayBuffer).not.toHaveBeenCalled();
  });

  it("cancels during the single logo read without configuring or reading sources", async () => {
    installSupportedRuntime();
    const logoRead = deferred<ArrayBuffer>();
    const logo = fakeFile({
      name: "logo.png",
      type: "image/png",
      size: 4,
      read: logoRead.promise,
    });
    const first = fakeFile({ name: "first.png" });
    const second = fakeFile({ name: "second.png" });
    const handle = runImageWatermarkBatch(
      [item("first", first.file, logoSpec), item("second", second.file, logoSpec)],
      { concurrency: 2, logoFile: logo.file },
    );
    const workers = [...StubWorker.instances];
    for (const worker of workers) worker.emit(readyEvent());
    await vi.waitFor(() => expect(logo.arrayBuffer).toHaveBeenCalledOnce());

    handle.cancel();
    logoRead.resolve(new ArrayBuffer(4));
    await Promise.resolve();
    await Promise.resolve();

    await expect(handle.result).resolves.toEqual([
      { itemId: "first", status: "cancelled" },
      { itemId: "second", status: "cancelled" },
    ]);
    expect(workers.every((worker) => worker.terminateCount === 1)).toBe(true);
    expect(workers.flatMap((worker) => messagesOfType(worker, "configure-logo"))).toHaveLength(0);
    expect(first.arrayBuffer).not.toHaveBeenCalled();
    expect(second.arrayBuffer).not.toHaveBeenCalled();
  });

  it("cancels during a source read, posts no run, and starts no later read", async () => {
    installSupportedRuntime();
    const firstRead = deferred<ArrayBuffer>();
    const first = fakeFile({ size: 4, read: firstRead.promise });
    const second = fakeFile({ name: "second.png" });
    const handle = runImageWatermarkBatch(
      [item("first", first.file), item("second", second.file)],
      { concurrency: 1 },
    );
    const worker = StubWorker.instances[0];
    if (worker === undefined) throw new Error("Expected a Worker.");
    worker.emit(readyEvent());
    await vi.waitFor(() => expect(first.arrayBuffer).toHaveBeenCalledOnce());

    handle.cancel();
    firstRead.resolve(new ArrayBuffer(4));
    await Promise.resolve();
    await Promise.resolve();

    await expect(handle.result).resolves.toEqual([
      { itemId: "first", status: "cancelled" },
      { itemId: "second", status: "cancelled" },
    ]);
    expect(messagesOfType(worker, "run")).toHaveLength(0);
    expect(second.arrayBuffer).not.toHaveBeenCalled();
    expect(worker.terminateCount).toBe(1);
  });

  it("preserves fulfilled items, cancels active/queued items, and ignores all late events", async () => {
    installSupportedRuntime();
    const third = fakeFile({ name: "third.png" });
    const progress = vi.fn();
    const handle = runImageWatermarkBatch(
      [item("first"), item("second"), item("third", third.file)],
      {
        concurrency: 1,
        onEvent: (event) => {
          if (event.type === "item-progress") progress(event);
        },
      },
    );
    const worker = StubWorker.instances[0];
    if (worker === undefined) throw new Error("Expected a Worker.");
    worker.emit(readyEvent());
    const firstRun = await waitForMessage(worker, "run");
    emitComplete(worker, firstRun);
    const activeRun = await waitForMessage(worker, "run", 2);
    const activeJobId = messageId(activeRun, "jobId");

    handle.cancel();
    handle.cancel();
    worker.emit({
      protocol: 1,
      type: "progress",
      jobId: activeJobId,
      sequence: 0,
      phase: "decoding",
      fraction: 0.4,
    });
    worker.emit({ protocol: 1, type: "complete", jobId: activeJobId, result: imageResult() });

    await expect(handle.result).resolves.toMatchObject([
      { itemId: "first", status: "fulfilled" },
      { itemId: "second", status: "cancelled" },
      { itemId: "third", status: "cancelled" },
    ]);
    const cancels = messagesOfType(worker, "cancel");
    expect(cancels).toHaveLength(1);
    expect(messageId(cancels[0] as PostedMessage, "jobId")).toBe(activeJobId);
    expect(worker.terminateCount).toBe(1);
    expect(third.arrayBuffer).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
  });
});
