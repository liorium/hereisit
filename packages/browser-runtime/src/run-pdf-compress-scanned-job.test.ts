import type {
  PdfCompressScannedErrorPayload,
  PdfCompressScannedProgress,
  PdfCompressScannedResult,
  PdfCompressScannedSpecV1,
  PdfCompressScannedWorkerEvent,
} from "@hereisit/tool-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runPdfCompressScannedJob,
  supportsBrowserPdfCompressScannedRuntime,
} from "./run-pdf-compress-scanned-job";

const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MAX_PAGES = 100;
const balancedSpec: PdfCompressScannedSpecV1 = { version: 1, preset: "balanced" };
const WARNINGS = [
  "PDF_PAGES_RASTERIZED",
  "SEARCHABLE_CONTENT_REMOVED",
  "INTERACTIVE_CONTENT_REMOVED",
  "SIGNATURES_INVALIDATED",
  "COLOR_PROFILE_NORMALIZED",
] as const;

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
    return new Blob([Uint8Array.of(0xff, 0xd8, 0xff)], { type: "image/jpeg" });
  }
}

interface FakeFileOptions {
  name?: string;
  type?: string;
  size?: number;
  read?: Promise<ArrayBuffer>;
  arrayBuffer?: unknown;
}

function fakePdfFile(options: FakeFileOptions = {}): {
  file: File;
  arrayBuffer: ReturnType<typeof vi.fn>;
} {
  const size = options.size ?? 100;
  const read = options.read ?? Promise.resolve(new ArrayBuffer(size > MAX_PDF_BYTES ? 1 : size));
  const arrayBuffer = vi.fn(() => read);
  return {
    file: {
      name: options.name ?? "report.pdf",
      type: options.type ?? "application/pdf",
      size,
      arrayBuffer: options.arrayBuffer ?? arrayBuffer,
    } as unknown as File,
    arrayBuffer,
  };
}

function pdfBytes(byteLength = 20): ArrayBuffer {
  const prefix = new TextEncoder().encode("%PDF-1.4\n");
  const suffix = new TextEncoder().encode("%%EOF");
  if (byteLength < prefix.byteLength + suffix.byteLength) {
    return new TextEncoder().encode("%PDF-\n%%EOF").buffer;
  }
  const bytes = new Uint8Array(byteLength);
  bytes.set(prefix);
  bytes.fill(0x20, prefix.byteLength, byteLength - suffix.byteLength);
  bytes.set(suffix, byteLength - suffix.byteLength);
  return bytes.buffer;
}

function scannedResult(
  overrides: Partial<Omit<PdfCompressScannedResult, "timing">> & {
    timing?: Partial<PdfCompressScannedResult["timing"]>;
  } = {},
): PdfCompressScannedResult {
  const bytes = overrides.bytes ?? pdfBytes();
  return {
    bytes,
    suggestedName: "report-compressed-hereisit.pdf",
    mime: "application/pdf",
    sourceByteLength: 100,
    byteLength: bytes.byteLength,
    pageCount: 1,
    preset: "balanced",
    dpi: 150,
    quality: 72,
    warnings: [...WARNINGS],
    ...overrides,
    timing: {
      loadMs: 1,
      renderMs: 2,
      encodeMs: 3,
      assembleMs: 4,
      serializeMs: 5,
      totalMs: 15,
      ...overrides.timing,
    },
  };
}

function installSupportedRuntime(worker: unknown = StubWorker): void {
  vi.stubGlobal("Worker", worker);
  vi.stubGlobal("File", class {});
  vi.stubGlobal("OffscreenCanvas", SupportedOffscreenCanvas);
}

function latestWorker(): StubWorker {
  const worker = StubWorker.instances.at(-1);
  if (worker === undefined) throw new Error("Expected a Worker instance.");
  return worker;
}

function isMessageType(message: unknown, type: string): message is { type: string; jobId: string } {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === type &&
    "jobId" in message &&
    typeof message.jobId === "string"
  );
}

function readyEvent(
  overrides: Partial<Extract<PdfCompressScannedWorkerEvent, { type: "ready" }>> = {},
): Extract<PdfCompressScannedWorkerEvent, { type: "ready" }> {
  return {
    protocol: 1,
    type: "ready",
    capabilities: {
      offscreenCanvas: true,
      jpegEncoder: true,
      pdfjsWorker: true,
      pdfAssembly: true,
    },
    error: null,
    ...overrides,
  };
}

async function waitForRun(worker: StubWorker): Promise<PostedMessage> {
  if (!worker.messages.some(({ message }) => isMessageType(message, "run"))) {
    worker.emit(readyEvent());
  }
  await vi.waitFor(() => {
    expect(worker.messages.some(({ message }) => isMessageType(message, "run"))).toBe(true);
  });
  const run = worker.messages.find(({ message }) => isMessageType(message, "run"));
  if (run === undefined) throw new Error("Expected a run request.");
  return run;
}

function progressEvent(
  jobId: string,
  sequence: number,
  progress: PdfCompressScannedProgress = { phase: "loading", fraction: 0.05 },
): PdfCompressScannedWorkerEvent {
  return {
    protocol: 1,
    type: "progress",
    jobId,
    sequence,
    ...progress,
  };
}

function emitFinalizing(worker: StubWorker, jobId: string, sequence = 0): void {
  worker.emit(progressEvent(jobId, sequence, { phase: "finalizing", fraction: 1 }));
}

function installChangingGetter<T extends object, K extends PropertyKey>(
  target: T,
  key: K,
  first: unknown,
  second: unknown,
): ReturnType<typeof vi.fn> {
  const getter = vi.fn<() => unknown>();
  getter.mockReturnValueOnce(first).mockReturnValue(second);
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    get: getter,
  });
  return getter;
}

function objectWithCustomPrototype<T extends object>(value: T): T {
  return Object.assign(Object.create({ inheritedBoundaryField: "blocked" }), value) as T;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  StubWorker.instances = [];
  SupportedOffscreenCanvas.instances = [];
});

describe("supportsBrowserPdfCompressScannedRuntime", () => {
  it.each([
    "Worker",
    "File",
    "OffscreenCanvas",
  ] as const)("requires the %s browser primitive", (primitive) => {
    installSupportedRuntime();
    vi.stubGlobal(primitive, undefined);

    expect(supportsBrowserPdfCompressScannedRuntime()).toBe(false);
  });

  it("requires a 2D context and convertToBlob and always releases both canvas axes", () => {
    installSupportedRuntime();

    expect(supportsBrowserPdfCompressScannedRuntime()).toBe(true);
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
    expect(supportsBrowserPdfCompressScannedRuntime()).toBe(false);

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
    expect(supportsBrowserPdfCompressScannedRuntime()).toBe(false);
  });

  it("returns false and releases both axes when the support probe throws", () => {
    let probed: { width: number; height: number } | undefined;
    installSupportedRuntime();
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        width: number;
        height: number;
        constructor(width: number, height: number) {
          this.width = width;
          this.height = height;
          probed = this;
        }
        getContext(): never {
          throw new Error("blocked");
        }
      },
    );

    expect(supportsBrowserPdfCompressScannedRuntime()).toBe(false);
    expect(probed).toMatchObject({ width: 0, height: 0 });
  });
});

describe("runPdfCompressScannedJob validation and readiness", () => {
  it("rejects an unsupported runtime before constructing a Worker or reading", async () => {
    installSupportedRuntime();
    vi.stubGlobal("OffscreenCanvas", undefined);
    const { file, arrayBuffer } = fakePdfFile();

    const handle = runPdfCompressScannedJob(file, balancedSpec, { expectedPageCount: 1 });

    await expect(handle.result).resolves.toEqual({
      status: "rejected",
      error: expect.objectContaining({ code: "UNSUPPORTED_BROWSER", retryable: false }),
    });
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(StubWorker.instances).toHaveLength(0);
  });

  it.each([
    0,
    MAX_PDF_BYTES + 1,
  ])("rejects an invalid %d-byte input before Worker construction or reading", async (size) => {
    installSupportedRuntime();
    const { file, arrayBuffer } = fakePdfFile({ size });

    const handle = runPdfCompressScannedJob(file, balancedSpec, { expectedPageCount: 1 });

    await expect(handle.result).resolves.toMatchObject({
      status: "rejected",
      error: { code: "MEMORY_LIMIT", retryable: false },
    });
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(StubWorker.instances).toHaveLength(0);
  });

  it("rejects a non-PDF file before Worker construction or reading", async () => {
    installSupportedRuntime();
    const { file, arrayBuffer } = fakePdfFile({ name: "report.txt", type: "text/plain" });

    const handle = runPdfCompressScannedJob(file, balancedSpec, { expectedPageCount: 1 });

    await expect(handle.result).resolves.toMatchObject({
      status: "rejected",
      error: { code: "UNSUPPORTED_INPUT", retryable: false },
    });
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(StubWorker.instances).toHaveLength(0);
  });

  it.each([
    {
      name: "invalid spec",
      spec: { version: 1, preset: "lossless" },
      options: { expectedPageCount: 1 },
      code: "INVALID_SPEC",
    },
    {
      name: "zero expected pages",
      spec: balancedSpec,
      options: { expectedPageCount: 0 },
      code: "PAGE_LIMIT",
    },
    {
      name: "too many expected pages",
      spec: balancedSpec,
      options: { expectedPageCount: MAX_PAGES + 1 },
      code: "PAGE_LIMIT",
    },
    {
      name: "non-callable progress observer",
      spec: balancedSpec,
      options: { expectedPageCount: 1, onProgress: "listen" },
      code: "INVALID_SPEC",
    },
  ])("rejects $name before Worker construction or reading", async ({ spec, options, code }) => {
    installSupportedRuntime();
    const { file, arrayBuffer } = fakePdfFile();

    const handle = runPdfCompressScannedJob(
      file,
      spec as PdfCompressScannedSpecV1,
      options as { expectedPageCount: number },
    );

    await expect(handle.result).resolves.toMatchObject({
      status: "rejected",
      error: { code, retryable: false },
    });
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(StubWorker.instances).toHaveLength(0);
  });

  it("constructs the dedicated module Worker but performs zero reads before exact readiness", async () => {
    installSupportedRuntime();
    const { file, arrayBuffer } = fakePdfFile();
    const onProgress = vi.fn();

    runPdfCompressScannedJob(file, balancedSpec, { expectedPageCount: 1, onProgress });
    const worker = latestWorker();

    expect(worker.url.pathname).toMatch(/\/pdf-compress-scanned\.worker\.ts$/);
    expect(worker.options).toEqual({
      type: "module",
      name: "hereisit-pdf-compress-scanned-worker",
    });
    expect(onProgress).toHaveBeenCalledExactlyOnceWith({ phase: "validating", fraction: 0 });
    expect(arrayBuffer).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(arrayBuffer).not.toHaveBeenCalled();

    worker.emit(readyEvent());
    worker.emit(readyEvent());
    await vi.waitFor(() => expect(arrayBuffer).toHaveBeenCalledOnce());
    expect(arrayBuffer).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "canvas/JPEG unsupported",
      capabilities: {
        offscreenCanvas: false,
        jpegEncoder: false,
        pdfjsWorker: true,
        pdfAssembly: true,
      },
      error: {
        code: "UNSUPPORTED_BROWSER",
        message: "이 브라우저는 로컬 스캔 PDF 압축을 지원하지 않아요.",
        retryable: false,
      },
    },
    {
      name: "parser probe failure",
      capabilities: {
        offscreenCanvas: true,
        jpegEncoder: true,
        pdfjsWorker: false,
        pdfAssembly: true,
      },
      error: {
        code: "WORKER_CRASH",
        message: "스캔 PDF 압축 작업기를 준비하지 못했어요.",
        retryable: true,
      },
    },
    {
      name: "assembly probe failure",
      capabilities: {
        offscreenCanvas: true,
        jpegEncoder: true,
        pdfjsWorker: true,
        pdfAssembly: false,
      },
      error: {
        code: "WORKER_CRASH",
        message: "스캔 PDF 압축 작업기를 준비하지 못했어요.",
        retryable: true,
      },
    },
  ])("maps $name readiness and performs no file read", async ({ capabilities, error }) => {
    installSupportedRuntime();
    const { file, arrayBuffer } = fakePdfFile();
    const handle = runPdfCompressScannedJob(file, balancedSpec, { expectedPageCount: 1 });
    const worker = latestWorker();

    worker.emit(readyEvent({ capabilities, error: error as PdfCompressScannedErrorPayload }));

    await expect(handle.result).resolves.toEqual({ status: "rejected", error });
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(worker.messages).toHaveLength(0);
    expect(worker.terminateCount).toBe(1);
  });

  it.each([
    "error",
    "messageerror",
  ])("rejects nested parser %s after PDFWorker.promise without reading or posting run", async () => {
    installSupportedRuntime();
    const { file, arrayBuffer } = fakePdfFile();
    const handle = runPdfCompressScannedJob(file, balancedSpec, { expectedPageCount: 1 });
    const worker = latestWorker();

    await Promise.resolve(); // the nested PDFWorker.promise has resolved, but its probe PDF has not
    worker.emit(
      readyEvent({
        capabilities: {
          offscreenCanvas: true,
          jpegEncoder: true,
          pdfjsWorker: false,
          pdfAssembly: true,
        },
        error: {
          code: "WORKER_CRASH",
          message: "스캔 PDF 압축 작업기를 준비하지 못했어요.",
          retryable: true,
        },
      }),
    );

    await expect(handle.result).resolves.toMatchObject({
      status: "rejected",
      error: { code: "WORKER_CRASH", retryable: true },
    });
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(worker.messages.some(({ message }) => isMessageType(message, "run"))).toBe(false);
  });

  it.each([
    readyEvent({ error: { code: "WORKER_CRASH", message: "bad", retryable: true } }),
    readyEvent({
      capabilities: {
        offscreenCanvas: true,
        jpegEncoder: true,
        pdfjsWorker: false,
        pdfAssembly: true,
      },
      error: null,
    }),
    { ...readyEvent(), protocol: 2 },
  ])("turns inconsistent or malformed readiness into an immediate protocol failure", async (event) => {
    installSupportedRuntime();
    const { file, arrayBuffer } = fakePdfFile();
    const handle = runPdfCompressScannedJob(file, balancedSpec, { expectedPageCount: 1 });
    const worker = latestWorker();

    worker.emit(event);

    await expect(handle.result).resolves.toMatchObject({
      status: "rejected",
      error: { code: "WORKER_CRASH", retryable: true },
    });
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(worker.terminateCount).toBe(1);
  });

  it.each([
    {
      name: "array",
      makeEvent: () => Object.assign([], readyEvent()),
    },
    {
      name: "custom-prototype object",
      makeEvent: () => objectWithCustomPrototype(readyEvent()),
    },
    {
      name: "ready event with array capabilities",
      makeEvent: () =>
        readyEvent({
          capabilities: Object.assign([], {
            offscreenCanvas: true,
            jpegEncoder: true,
            pdfjsWorker: true,
            pdfAssembly: true,
          }) as unknown as Extract<
            PdfCompressScannedWorkerEvent,
            { type: "ready" }
          >["capabilities"],
        }),
    },
    {
      name: "ready event with array error",
      makeEvent: () =>
        readyEvent({
          capabilities: {
            offscreenCanvas: false,
            jpegEncoder: false,
            pdfjsWorker: true,
            pdfAssembly: true,
          },
          error: Object.assign([], {
            code: "UNSUPPORTED_BROWSER",
            message: "safe",
            retryable: false,
          }) as unknown as PdfCompressScannedErrorPayload,
        }),
    },
  ])("rejects a $name masquerading as a ready event before reading", async ({ makeEvent }) => {
    installSupportedRuntime();
    const { file, arrayBuffer } = fakePdfFile();
    const handle = runPdfCompressScannedJob(file, balancedSpec, { expectedPageCount: 1 });
    const worker = latestWorker();
    const observer = vi.fn();
    void handle.result.then(observer);

    worker.emit(makeEvent());
    await Promise.resolve();

    expect(observer).toHaveBeenCalledOnce();
    await expect(handle.result).resolves.toMatchObject({
      status: "rejected",
      error: {
        code: "WORKER_CRASH",
        message: "스캔 PDF 압축 작업기 응답을 확인하지 못했어요.",
        retryable: true,
      },
    });
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(worker.terminateCount).toBe(1);
  });
});

describe("runPdfCompressScannedJob lifecycle", () => {
  it("maps Worker construction failure before reading", async () => {
    class ThrowingWorker extends StubWorker {
      constructor(url: URL, options?: WorkerOptions) {
        super(url, options);
        throw new DOMException("blocked", "SecurityError");
      }
    }
    installSupportedRuntime(ThrowingWorker);
    const first = fakePdfFile();
    const construction = runPdfCompressScannedJob(first.file, balancedSpec, {
      expectedPageCount: 1,
    });
    await expect(construction.result).resolves.toMatchObject({
      status: "rejected",
      error: { code: "WORKER_CRASH", retryable: true },
    });
    expect(first.arrayBuffer).not.toHaveBeenCalled();
  });

  it.each([
    "error",
    "messageerror",
  ] as const)("maps a top-level Worker %s to one failure and ignores later events", async (eventType) => {
    installSupportedRuntime();
    const { file, arrayBuffer } = fakePdfFile();
    const runtime = runPdfCompressScannedJob(file, balancedSpec, { expectedPageCount: 1 });
    const worker = latestWorker();
    const observer = vi.fn();
    void runtime.result.then(observer);
    if (eventType === "error") {
      worker.onerror?.(new Error("crash"));
    } else {
      worker.onmessageerror?.({ data: undefined } as MessageEvent<unknown>);
    }
    worker.emit(readyEvent());

    await expect(runtime.result).resolves.toMatchObject({
      status: "rejected",
      error: { code: "WORKER_CRASH", retryable: true },
    });
    await Promise.resolve();
    expect(observer).toHaveBeenCalledOnce();
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(worker.terminateCount).toBe(1);
  });

  it("maps file read rejection and byte-length mismatch without posting run", async () => {
    installSupportedRuntime();
    const unreadable = fakePdfFile({ read: Promise.reject(new Error("read failed")) });
    const first = runPdfCompressScannedJob(unreadable.file, balancedSpec, {
      expectedPageCount: 1,
    });
    latestWorker().emit(readyEvent());
    await expect(first.result).resolves.toMatchObject({
      status: "rejected",
      error: { code: "CORRUPT_PDF", retryable: true },
    });
    expect(latestWorker().messages).toHaveLength(0);

    const mismatch = fakePdfFile({ size: 100, read: Promise.resolve(new ArrayBuffer(99)) });
    const second = runPdfCompressScannedJob(mismatch.file, balancedSpec, { expectedPageCount: 1 });
    latestWorker().emit(readyEvent());
    await expect(second.result).resolves.toMatchObject({
      status: "rejected",
      error: { code: "CORRUPT_PDF", retryable: false },
    });
    expect(latestWorker().messages).toHaveLength(0);
  });

  it("posts the exact request once and transfers only the source buffer", async () => {
    installSupportedRuntime();
    const bytes = new ArrayBuffer(100);
    const { file, arrayBuffer } = fakePdfFile({ read: Promise.resolve(bytes) });

    runPdfCompressScannedJob(file, balancedSpec, { expectedPageCount: 73 });
    const worker = latestWorker();
    const run = await waitForRun(worker);

    expect(arrayBuffer).toHaveBeenCalledOnce();
    expect(run.transfer).toEqual([bytes]);
    expect(run.message).toMatchObject({
      protocol: 1,
      type: "run",
      tool: "pdf.compress-scanned",
      toolVersion: 1,
      input: {
        name: "report.pdf",
        mimeHint: "application/pdf",
        byteLength: 100,
        bytes,
      },
      spec: balancedSpec,
    });
    const request = run.message as Record<string, unknown>;
    expect(Object.keys(request).sort()).toEqual(
      ["protocol", "type", "jobId", "tool", "toolVersion", "input", "spec"].sort(),
    );
    expect(Object.keys(request.input as object).sort()).toEqual(
      ["name", "mimeHint", "byteLength", "bytes"].sort(),
    );
    expect(Object.keys(request.spec as object).sort()).toEqual(["version", "preset"].sort());
    expect(JSON.stringify(request)).not.toContain("expectedPageCount");
  });

  it("maps a run postMessage exception to one retryable protocol failure", async () => {
    class ThrowingPostWorker extends StubWorker {
      override postMessage(message: unknown, transfer: readonly Transferable[] = []): void {
        super.postMessage(message, transfer);
        if (isMessageType(message, "run")) throw new DOMException("detached", "DataCloneError");
      }
    }
    installSupportedRuntime(ThrowingPostWorker);
    const { file } = fakePdfFile();
    const handle = runPdfCompressScannedJob(file, balancedSpec, { expectedPageCount: 1 });
    const worker = latestWorker();

    worker.emit(readyEvent());

    await expect(handle.result).resolves.toMatchObject({
      status: "rejected",
      error: { code: "WORKER_CRASH", retryable: true },
    });
    expect(worker.terminateCount).toBe(1);
  });

  it("starts the 180-second watchdog at handle creation", async () => {
    vi.useFakeTimers();
    installSupportedRuntime();
    const { file, arrayBuffer } = fakePdfFile();
    const handle = runPdfCompressScannedJob(file, balancedSpec, { expectedPageCount: 1 });
    const worker = latestWorker();
    const observer = vi.fn();
    void handle.result.then(observer);

    await vi.advanceTimersByTimeAsync(179_999);
    expect(observer).not.toHaveBeenCalled();
    expect(arrayBuffer).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await expect(handle.result).resolves.toMatchObject({
      status: "rejected",
      error: { code: "WORKER_CRASH", retryable: true },
    });
    expect(worker.terminateCount).toBe(1);
  });

  it("cancels immediately before readiness without reading or posting", async () => {
    installSupportedRuntime();
    const { file, arrayBuffer } = fakePdfFile();
    const handle = runPdfCompressScannedJob(file, balancedSpec, { expectedPageCount: 1 });
    const worker = latestWorker();

    handle.cancel();
    worker.emit(readyEvent());

    await expect(handle.result).resolves.toEqual({ status: "cancelled" });
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(worker.messages).toHaveLength(0);
    expect(worker.terminateCount).toBe(1);
  });

  it("cancels while reading without posting a run", async () => {
    installSupportedRuntime();
    let releaseRead: (bytes: ArrayBuffer) => void = () => undefined;
    const read = new Promise<ArrayBuffer>((resolve) => {
      releaseRead = resolve;
    });
    const { file, arrayBuffer } = fakePdfFile({ read });
    const handle = runPdfCompressScannedJob(file, balancedSpec, { expectedPageCount: 1 });
    const worker = latestWorker();
    worker.emit(readyEvent());
    await vi.waitFor(() => expect(arrayBuffer).toHaveBeenCalledOnce());

    handle.cancel();
    releaseRead(new ArrayBuffer(100));
    await Promise.resolve();
    await Promise.resolve();

    await expect(handle.result).resolves.toEqual({ status: "cancelled" });
    expect(worker.messages.some(({ message }) => isMessageType(message, "run"))).toBe(false);
    expect(worker.terminateCount).toBe(1);
  });

  it("cancels a posted run exactly once and ignores late events", async () => {
    installSupportedRuntime();
    const { file } = fakePdfFile();
    const onProgress = vi.fn();
    const handle = runPdfCompressScannedJob(file, balancedSpec, {
      expectedPageCount: 1,
      onProgress,
    });
    const worker = latestWorker();
    const run = await waitForRun(worker);
    if (!isMessageType(run.message, "run")) throw new Error("Expected a run request.");

    handle.cancel();
    handle.cancel();
    worker.emit(progressEvent(run.message.jobId, 0));
    worker.emit({
      protocol: 1,
      type: "complete",
      jobId: run.message.jobId,
      result: scannedResult(),
    });

    await expect(handle.result).resolves.toEqual({ status: "cancelled" });
    expect(worker.messages.filter(({ message }) => isMessageType(message, "cancel"))).toHaveLength(
      1,
    );
    expect(worker.terminateCount).toBe(1);
    expect(onProgress).toHaveBeenCalledTimes(1);
  });
});

describe("runPdfCompressScannedJob hostile progress and terminal boundary", () => {
  it("does not let a matching finalizing event before run authorize completion", async () => {
    installSupportedRuntime();
    vi.stubGlobal("crypto", { randomUUID: () => "fixed-job" });
    const { file } = fakePdfFile();
    const handle = runPdfCompressScannedJob(file, balancedSpec, { expectedPageCount: 1 });
    const worker = latestWorker();

    emitFinalizing(worker, "fixed-job");
    const run = await waitForRun(worker);
    if (!isMessageType(run.message, "run")) throw new Error("Expected a run request.");
    worker.emit({
      protocol: 1,
      type: "complete",
      jobId: run.message.jobId,
      result: scannedResult(),
    });

    await expect(handle.result).resolves.toMatchObject({
      status: "rejected",
      error: { code: "WORKER_CRASH", retryable: true },
    });
  });

  it("fails closed when a hostile matching event throws during decoding", async () => {
    installSupportedRuntime();
    const { file } = fakePdfFile();
    const handle = runPdfCompressScannedJob(file, balancedSpec, { expectedPageCount: 1 });
    const worker = latestWorker();
    await waitForRun(worker);
    const hostile = Object.defineProperty({}, "type", {
      get(): never {
        throw new Error("hostile getter");
      },
    });

    expect(() => worker.emit(hostile)).not.toThrow();
    await expect(handle.result).resolves.toMatchObject({
      status: "rejected",
      error: { code: "WORKER_CRASH", retryable: true },
    });
    expect(worker.terminateCount).toBe(1);
  });

  it("captures result bytes exactly once before validating and fulfilling", async () => {
    installSupportedRuntime();
    const { file } = fakePdfFile();
    const handle = runPdfCompressScannedJob(file, balancedSpec, { expectedPageCount: 1 });
    const worker = latestWorker();
    const run = await waitForRun(worker);
    if (!isMessageType(run.message, "run")) throw new Error("Expected a run request.");
    emitFinalizing(worker, run.message.jobId);
    const clean = scannedResult();
    const bytes = clean.bytes;
    const bytesGetter = installChangingGetter(clean, "bytes", bytes, new ArrayBuffer(0));

    worker.emit({ protocol: 1, type: "complete", jobId: run.message.jobId, result: clean });

    await expect(handle.result).resolves.toMatchObject({
      status: "fulfilled",
      value: { bytes, byteLength: bytes.byteLength },
    });
    expect(bytesGetter).toHaveBeenCalledOnce();
  });

  it("rejects a shadowed ArrayBuffer without invoking its byte-length getter", async () => {
    installSupportedRuntime();
    const { file } = fakePdfFile();
    const handle = runPdfCompressScannedJob(file, balancedSpec, { expectedPageCount: 1 });
    const worker = latestWorker();
    const run = await waitForRun(worker);
    if (!isMessageType(run.message, "run")) throw new Error("Expected a run request.");
    emitFinalizing(worker, run.message.jobId);
    const bytes = pdfBytes();
    const clean = scannedResult({ bytes, byteLength: 20 });
    const shadowGetter = vi.fn(() => 0);
    Object.defineProperty(bytes, "byteLength", { configurable: true, get: shadowGetter });

    worker.emit({ protocol: 1, type: "complete", jobId: run.message.jobId, result: clean });

    const outcome = await handle.result;
    expect(outcome).toMatchObject({
      status: "rejected",
      error: { code: "WORKER_CRASH", retryable: true },
    });
    expect(shadowGetter).not.toHaveBeenCalled();
  });

  it("captures the suggested public name exactly once and never reads an unsafe replacement", async () => {
    installSupportedRuntime();
    const { file } = fakePdfFile();
    const handle = runPdfCompressScannedJob(file, balancedSpec, { expectedPageCount: 1 });
    const worker = latestWorker();
    const run = await waitForRun(worker);
    if (!isMessageType(run.message, "run")) throw new Error("Expected a run request.");
    emitFinalizing(worker, run.message.jobId);
    const clean = scannedResult();
    const nameGetter = installChangingGetter(
      clean,
      "suggestedName",
      "report-compressed-hereisit.pdf",
      "PRIVATE_SENTINEL\u202e.pdf",
    );

    worker.emit({ protocol: 1, type: "complete", jobId: run.message.jobId, result: clean });

    const outcome = await handle.result;
    expect(outcome).toMatchObject({
      status: "fulfilled",
      value: { suggestedName: "report-compressed-hereisit.pdf" },
    });
    expect(nameGetter).toHaveBeenCalledOnce();
    expect(JSON.stringify(outcome)).not.toContain("PRIVATE_SENTINEL");
  });

  it("captures every failed-error field once and exposes only validated first values", async () => {
    installSupportedRuntime();
    const { file } = fakePdfFile();
    const handle = runPdfCompressScannedJob(file, balancedSpec, { expectedPageCount: 1 });
    const worker = latestWorker();
    const run = await waitForRun(worker);
    if (!isMessageType(run.message, "run")) throw new Error("Expected a run request.");
    const error: Record<string, unknown> = {};
    const codeGetter = installChangingGetter(error, "code", "WORKER_CRASH", "PRIVATE_CODE");
    const messageGetter = installChangingGetter(
      error,
      "message",
      "safe",
      "PRIVATE_ERROR_SENTINEL\u202e",
    );
    const retryableGetter = installChangingGetter(error, "retryable", true, "PRIVATE_RETRY");

    worker.emit({ protocol: 1, type: "failed", jobId: run.message.jobId, error });

    const outcome = await handle.result;
    expect(outcome).toEqual({
      status: "rejected",
      error: { code: "WORKER_CRASH", message: "safe", retryable: true },
    });
    expect(codeGetter).toHaveBeenCalledOnce();
    expect(messageGetter).toHaveBeenCalledOnce();
    expect(retryableGetter).toHaveBeenCalledOnce();
    expect(JSON.stringify(outcome)).not.toContain("PRIVATE_");
  });

  it("captures progress phase and fraction once before notifying", async () => {
    installSupportedRuntime();
    const { file } = fakePdfFile();
    const onProgress = vi.fn();
    const handle = runPdfCompressScannedJob(file, balancedSpec, {
      expectedPageCount: 1,
      onProgress,
    });
    const worker = latestWorker();
    const run = await waitForRun(worker);
    if (!isMessageType(run.message, "run")) throw new Error("Expected a run request.");
    const progress: Record<string, unknown> = {
      protocol: 1,
      type: "progress",
      jobId: run.message.jobId,
      sequence: 0,
    };
    const phaseGetter = installChangingGetter(progress, "phase", "loading", "PRIVATE_PHASE");
    const fractionGetter = installChangingGetter(progress, "fraction", 0.05, -1);

    worker.emit(progress);

    expect(onProgress).toHaveBeenLastCalledWith({ phase: "loading", fraction: 0.05 });
    expect(phaseGetter).toHaveBeenCalledOnce();
    expect(fractionGetter).toHaveBeenCalledOnce();
    handle.cancel();
    await expect(handle.result).resolves.toEqual({ status: "cancelled" });
  });

  it("ignores a valid wrong-job progress ID before reading any later hostile fields", async () => {
    installSupportedRuntime();
    const { file } = fakePdfFile();
    const handle = runPdfCompressScannedJob(file, balancedSpec, { expectedPageCount: 1 });
    const worker = latestWorker();
    const run = await waitForRun(worker);
    if (!isMessageType(run.message, "run")) throw new Error("Expected a run request.");
    const wrongJobProgress: Record<string, unknown> = {};
    const jobIdGetter = installChangingGetter(
      wrongJobProgress,
      "jobId",
      "another-job",
      new Error("job ID was reread"),
    );
    const laterGetters = [
      "type",
      "protocol",
      "sequence",
      "phase",
      "fraction",
      "completedPages",
      "totalPages",
    ].map((key) => {
      const getter = vi.fn((): never => {
        throw new Error(`wrong-job ${key} must stay unread`);
      });
      Object.defineProperty(wrongJobProgress, key, { enumerable: true, get: getter });
      return getter;
    });

    worker.emit(wrongJobProgress);
    emitFinalizing(worker, run.message.jobId);
    const clean = scannedResult();
    worker.emit({ protocol: 1, type: "complete", jobId: run.message.jobId, result: clean });

    await expect(handle.result).resolves.toEqual({ status: "fulfilled", value: clean });
    expect(jobIdGetter).toHaveBeenCalledOnce();
    for (const getter of laterGetters) expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    "complete",
    "failed",
  ] as const)("ignores a wrong-job %s before reading its hostile payload", async (type) => {
    installSupportedRuntime();
    const { file } = fakePdfFile();
    const handle = runPdfCompressScannedJob(file, balancedSpec, { expectedPageCount: 1 });
    const worker = latestWorker();
    const run = await waitForRun(worker);
    if (!isMessageType(run.message, "run")) throw new Error("Expected a run request.");
    const event: Record<string, unknown> = { jobId: "another-job" };
    const typeGetter = vi.fn((): never => {
      throw new Error("wrong-job type must stay unread");
    });
    const payloadGetter = vi.fn((): never => {
      throw new Error("wrong-job payload must stay unread");
    });
    Object.defineProperty(event, "type", { enumerable: true, get: typeGetter });
    Object.defineProperty(event, type === "complete" ? "result" : "error", {
      enumerable: true,
      get: payloadGetter,
    });

    worker.emit(event);
    emitFinalizing(worker, run.message.jobId);
    const clean = scannedResult();
    worker.emit({ protocol: 1, type: "complete", jobId: run.message.jobId, result: clean });

    await expect(handle.result).resolves.toEqual({ status: "fulfilled", value: clean });
    expect(typeGetter).not.toHaveBeenCalled();
    expect(payloadGetter).not.toHaveBeenCalled();
  });

  it("fails closed when completed pages regress despite increasing sequence and fraction", async () => {
    installSupportedRuntime();
    const { file } = fakePdfFile();
    const onProgress = vi.fn();
    const handle = runPdfCompressScannedJob(file, balancedSpec, {
      expectedPageCount: 2,
      onProgress,
    });
    const observer = vi.fn();
    void handle.result.then(observer);
    const worker = latestWorker();
    const run = await waitForRun(worker);
    if (!isMessageType(run.message, "run")) throw new Error("Expected a run request.");

    worker.emit(
      progressEvent(run.message.jobId, 0, {
        phase: "rendering",
        fraction: 0.3,
        completedPages: 2,
        totalPages: 2,
      }),
    );
    worker.emit(
      progressEvent(run.message.jobId, 1, {
        phase: "encoding",
        fraction: 0.4,
        completedPages: 1,
        totalPages: 2,
      }),
    );

    await Promise.resolve();
    expect(observer).toHaveBeenCalledOnce();
    await expect(handle.result).resolves.toMatchObject({
      status: "rejected",
      error: { code: "WORKER_CRASH", retryable: true },
    });
    expect(onProgress.mock.calls).toEqual([
      [{ phase: "validating", fraction: 0 }],
      [
        {
          phase: "rendering",
          fraction: 0.3,
          completedPages: 2,
          totalPages: 2,
        },
      ],
    ]);
  });

  it("allows the same completed-page count across render, encode, and assemble", async () => {
    installSupportedRuntime();
    const { file } = fakePdfFile();
    const handle = runPdfCompressScannedJob(file, balancedSpec, { expectedPageCount: 2 });
    const worker = latestWorker();
    const run = await waitForRun(worker);
    if (!isMessageType(run.message, "run")) throw new Error("Expected a run request.");
    for (const [sequence, phase] of ["rendering", "encoding", "assembling"].entries()) {
      worker.emit(
        progressEvent(run.message.jobId, sequence, {
          phase: phase as "rendering" | "encoding" | "assembling",
          fraction: 0.2 + sequence * 0.1,
          completedPages: 1,
          totalPages: 2,
        }),
      );
    }
    emitFinalizing(worker, run.message.jobId, 3);
    const clean = scannedResult({ pageCount: 2 });
    worker.emit({ protocol: 1, type: "complete", jobId: run.message.jobId, result: clean });

    await expect(handle.result).resolves.toEqual({ status: "fulfilled", value: clean });
  });

  it("accepts only matching, decoded, increasing progress and requires exact finalizing:1", async () => {
    installSupportedRuntime();
    const { file } = fakePdfFile();
    const onProgress = vi.fn();
    const handle = runPdfCompressScannedJob(file, balancedSpec, {
      expectedPageCount: 1,
      onProgress,
    });
    const worker = latestWorker();
    const run = await waitForRun(worker);
    if (!isMessageType(run.message, "run")) throw new Error("Expected a run request.");

    worker.emit(null);
    worker.emit(progressEvent("stale-job", 10));
    worker.emit({ ...progressEvent(run.message.jobId, 9), protocol: 2 });
    worker.emit(progressEvent(run.message.jobId, 2, { phase: "loading", fraction: 0.2 }));
    worker.emit(progressEvent(run.message.jobId, 1, { phase: "loading", fraction: 0.1 }));
    worker.emit(progressEvent(run.message.jobId, 2, { phase: "loading", fraction: 0.3 }));
    worker.emit(
      progressEvent(run.message.jobId, 3, {
        phase: "rendering",
        fraction: 0.5,
        completedPages: 1,
        totalPages: 2,
      }),
    );
    worker.emit(progressEvent(run.message.jobId, 4, { phase: "finalizing", fraction: 0.99 }));
    worker.emit({
      ...progressEvent(run.message.jobId, 5, { phase: "finalizing", fraction: 1 }),
      source: "/Users/private/report.pdf",
    });
    worker.emit({
      protocol: 1,
      type: "complete",
      jobId: run.message.jobId,
      result: scannedResult(),
    });

    await expect(handle.result).resolves.toMatchObject({ status: "fulfilled" });
    expect(onProgress.mock.calls).toEqual([
      [{ phase: "validating", fraction: 0 }],
      [{ phase: "loading", fraction: 0.2 }],
      [{ phase: "finalizing", fraction: 1 }],
    ]);
    expect(JSON.stringify(onProgress.mock.calls)).not.toContain("private");
  });

  it("turns completion before a valid finalizing:1 event into immediate protocol failure", async () => {
    installSupportedRuntime();
    const { file } = fakePdfFile();
    const handle = runPdfCompressScannedJob(file, balancedSpec, { expectedPageCount: 1 });
    const worker = latestWorker();
    const run = await waitForRun(worker);
    if (!isMessageType(run.message, "run")) throw new Error("Expected a run request.");

    worker.emit({
      protocol: 1,
      type: "complete",
      jobId: run.message.jobId,
      result: scannedResult(),
    });

    await expect(handle.result).resolves.toMatchObject({
      status: "rejected",
      error: { code: "WORKER_CRASH", retryable: true },
    });
    expect(worker.terminateCount).toBe(1);
  });

  const invalidResultCases: Array<{
    name: string;
    mutate: (value: PdfCompressScannedResult) => unknown;
  }> = [
    {
      name: "mismatched source size",
      mutate: (value) => ({ ...value, sourceByteLength: 99 }),
    },
    {
      name: "mismatched buffer length",
      mutate: (value) => ({ ...value, byteLength: value.byteLength + 1 }),
    },
    {
      name: "output above the exact 1% target",
      mutate: (value) => {
        const bytes = pdfBytes(100);
        return { ...value, bytes, byteLength: bytes.byteLength };
      },
    },
    {
      name: "missing PDF signature",
      mutate: (value) => {
        const bytes = value.bytes.slice(0);
        new Uint8Array(bytes)[0] = 0x00;
        return { ...value, bytes };
      },
    },
    {
      name: "missing exact PDF EOF",
      mutate: (value) => {
        const bytes = value.bytes.slice(0);
        new Uint8Array(bytes)[bytes.byteLength - 1] = 0x00;
        return { ...value, bytes };
      },
    },
    {
      name: "wrong MIME",
      mutate: (value) => ({ ...value, mime: "text/html" }),
    },
    {
      name: "wrong exact safe name",
      mutate: (value) => ({ ...value, suggestedName: "other-compressed-hereisit.pdf" }),
    },
    {
      name: "control text",
      mutate: (value) => ({ ...value, suggestedName: "report\n-compressed-hereisit.pdf" }),
    },
    {
      name: "C1 text",
      mutate: (value) => ({ ...value, suggestedName: "report\u0085-compressed-hereisit.pdf" }),
    },
    {
      name: "bidi text",
      mutate: (value) => ({ ...value, suggestedName: "report\u202e-compressed-hereisit.pdf" }),
    },
    {
      name: "wrong page count",
      mutate: (value) => ({ ...value, pageCount: 2 }),
    },
    {
      name: "wrong preset",
      mutate: (value) => ({ ...value, preset: "minimum" }),
    },
    {
      name: "wrong balanced DPI",
      mutate: (value) => ({ ...value, dpi: 96 }),
    },
    {
      name: "wrong balanced JPEG quality",
      mutate: (value) => ({ ...value, quality: 55 }),
    },
    {
      name: "missing warning",
      mutate: (value) => ({ ...value, warnings: value.warnings.slice(0, -1) }),
    },
    {
      name: "reordered warnings",
      mutate: (value) => ({
        ...value,
        warnings: [value.warnings[1], value.warnings[0], ...value.warnings.slice(2)],
      }),
    },
    {
      name: "non-finite timing",
      mutate: (value) => ({ ...value, timing: { ...value.timing, renderMs: Number.NaN } }),
    },
    {
      name: "negative timing",
      mutate: (value) => ({ ...value, timing: { ...value.timing, totalMs: -1 } }),
    },
    {
      name: "array result envelope",
      mutate: (value) => Object.assign([], value),
    },
    {
      name: "array timing envelope",
      mutate: (value) => ({ ...value, timing: Object.assign([], value.timing) }),
    },
  ];

  it.each([
    "loadMs",
    "renderMs",
    "encodeMs",
    "assembleMs",
    "serializeMs",
    "totalMs",
  ] as const)("accepts %s at exactly the 180-second bound", async (timingKey) => {
    installSupportedRuntime();
    const { file } = fakePdfFile();
    const handle = runPdfCompressScannedJob(file, balancedSpec, { expectedPageCount: 1 });
    const worker = latestWorker();
    const run = await waitForRun(worker);
    if (!isMessageType(run.message, "run")) throw new Error("Expected a run request.");
    emitFinalizing(worker, run.message.jobId);
    const boundary = scannedResult({
      timing: {
        loadMs: 0,
        renderMs: 0,
        encodeMs: 0,
        assembleMs: 0,
        serializeMs: 0,
        totalMs: 180_000,
        [timingKey]: 180_000,
      },
    });

    worker.emit({
      protocol: 1,
      type: "complete",
      jobId: run.message.jobId,
      result: boundary,
    });

    await expect(handle.result).resolves.toEqual({ status: "fulfilled", value: boundary });
  });

  it.each([
    "loadMs",
    "renderMs",
    "encodeMs",
    "assembleMs",
    "serializeMs",
    "totalMs",
  ] as const)("rejects %s one millisecond above the watchdog bound", async (timingKey) => {
    installSupportedRuntime();
    const { file } = fakePdfFile();
    const handle = runPdfCompressScannedJob(file, balancedSpec, { expectedPageCount: 1 });
    const worker = latestWorker();
    const run = await waitForRun(worker);
    if (!isMessageType(run.message, "run")) throw new Error("Expected a run request.");
    emitFinalizing(worker, run.message.jobId);
    const hostile = scannedResult({ timing: { [timingKey]: 180_001 } });

    worker.emit({
      protocol: 1,
      type: "complete",
      jobId: run.message.jobId,
      result: hostile,
    });

    await expect(handle.result).resolves.toMatchObject({
      status: "rejected",
      error: { code: "WORKER_CRASH", retryable: true },
    });
    expect(worker.terminateCount).toBe(1);
  });

  it.each(invalidResultCases)("rejects a matching complete event with $name immediately", async ({
    mutate,
  }) => {
    installSupportedRuntime();
    const { file } = fakePdfFile();
    const handle = runPdfCompressScannedJob(file, balancedSpec, { expectedPageCount: 1 });
    const worker = latestWorker();
    const run = await waitForRun(worker);
    if (!isMessageType(run.message, "run")) throw new Error("Expected a run request.");
    emitFinalizing(worker, run.message.jobId);

    worker.emit({
      protocol: 1,
      type: "complete",
      jobId: run.message.jobId,
      result: mutate(scannedResult()),
    });

    await expect(handle.result).resolves.toMatchObject({
      status: "rejected",
      error: { code: "WORKER_CRASH", retryable: true },
    });
    expect(worker.terminateCount).toBe(1);
  });

  it.each([
    {
      name: "null complete result",
      event: (jobId: string) => ({ protocol: 1, type: "complete", jobId, result: null }),
    },
    {
      name: "wrong-protocol complete",
      event: (jobId: string) => ({
        protocol: 2,
        type: "complete",
        jobId,
        result: scannedResult(),
      }),
    },
    {
      name: "malformed failure",
      event: (jobId: string) => ({
        protocol: 1,
        type: "failed",
        jobId,
        error: { code: "PRIVATE", message: "bad", retryable: "yes" },
      }),
    },
  ])("settles a $name as immediate retryable protocol failure", async ({ event }) => {
    installSupportedRuntime();
    const { file } = fakePdfFile();
    const handle = runPdfCompressScannedJob(file, balancedSpec, { expectedPageCount: 1 });
    const worker = latestWorker();
    const run = await waitForRun(worker);
    if (!isMessageType(run.message, "run")) throw new Error("Expected a run request.");
    emitFinalizing(worker, run.message.jobId);

    worker.emit(event(run.message.jobId));

    await expect(handle.result).resolves.toMatchObject({
      status: "rejected",
      error: { code: "WORKER_CRASH", retryable: true },
    });
    expect(worker.terminateCount).toBe(1);
  });

  it.each([
    "unsafe\nmessage",
    "unsafe\u0085message",
    "unsafe\u202emessage",
    "x".repeat(301),
  ])("rejects an unsafe failed-event message", async (message) => {
    installSupportedRuntime();
    const { file } = fakePdfFile();
    const handle = runPdfCompressScannedJob(file, balancedSpec, { expectedPageCount: 1 });
    const worker = latestWorker();
    const run = await waitForRun(worker);
    if (!isMessageType(run.message, "run")) throw new Error("Expected a run request.");

    worker.emit({
      protocol: 1,
      type: "failed",
      jobId: run.message.jobId,
      error: { code: "WORKER_CRASH", message, retryable: true },
    });

    await expect(handle.result).resolves.toMatchObject({
      status: "rejected",
      error: { code: "WORKER_CRASH", retryable: true },
    });
    const outcome = await handle.result;
    expect(JSON.stringify(outcome)).not.toContain(message);
  });

  it("strips unknown fields from valid progress, failure, and completion payloads", async () => {
    installSupportedRuntime();
    const firstFile = fakePdfFile();
    const first = runPdfCompressScannedJob(firstFile.file, balancedSpec, { expectedPageCount: 1 });
    const firstWorker = latestWorker();
    const firstRun = await waitForRun(firstWorker);
    if (!isMessageType(firstRun.message, "run")) throw new Error("Expected a run request.");
    firstWorker.emit({
      protocol: 1,
      type: "failed",
      jobId: firstRun.message.jobId,
      error: {
        code: "WORKER_CRASH",
        message: "safe",
        retryable: true,
        raw: "PRIVATE",
      },
    });
    await expect(first.result).resolves.toEqual({
      status: "rejected",
      error: { code: "WORKER_CRASH", message: "safe", retryable: true },
    });

    const secondFile = fakePdfFile();
    const onProgress = vi.fn();
    const second = runPdfCompressScannedJob(secondFile.file, balancedSpec, {
      expectedPageCount: 1,
      onProgress,
    });
    const secondWorker = latestWorker();
    const secondRun = await waitForRun(secondWorker);
    if (!isMessageType(secondRun.message, "run")) throw new Error("Expected a run request.");
    secondWorker.emit({
      ...progressEvent(secondRun.message.jobId, 0, { phase: "finalizing", fraction: 1 }),
      raw: "PRIVATE",
    });
    const clean = scannedResult();
    secondWorker.emit({
      protocol: 1,
      type: "complete",
      jobId: secondRun.message.jobId,
      result: {
        ...clean,
        raw: "PRIVATE",
        timing: { ...clean.timing, raw: "PRIVATE" },
      },
    });

    await expect(second.result).resolves.toEqual({ status: "fulfilled", value: clean });
    expect(JSON.stringify(await second.result)).not.toContain("PRIVATE");
    expect(JSON.stringify(onProgress.mock.calls)).not.toContain("PRIVATE");
  });

  it("accepts the exact minimum tuple and exact target boundary", async () => {
    installSupportedRuntime();
    const spec: PdfCompressScannedSpecV1 = { version: 1, preset: "minimum" };
    const { file } = fakePdfFile();
    const handle = runPdfCompressScannedJob(file, spec, { expectedPageCount: 1 });
    const worker = latestWorker();
    const run = await waitForRun(worker);
    if (!isMessageType(run.message, "run")) throw new Error("Expected a run request.");
    emitFinalizing(worker, run.message.jobId);
    const bytes = pdfBytes(99);
    const exact = scannedResult({
      bytes,
      byteLength: bytes.byteLength,
      preset: "minimum",
      dpi: 96,
      quality: 55,
    });

    worker.emit({
      protocol: 1,
      type: "complete",
      jobId: run.message.jobId,
      result: exact,
    });

    await expect(handle.result).resolves.toEqual({ status: "fulfilled", value: exact });
  });

  it("ignores wrong-job terminals, then settles once and never inspects duplicate or late events", async () => {
    installSupportedRuntime();
    const { file } = fakePdfFile();
    const handle = runPdfCompressScannedJob(file, balancedSpec, { expectedPageCount: 1 });
    const worker = latestWorker();
    const run = await waitForRun(worker);
    if (!isMessageType(run.message, "run")) throw new Error("Expected a run request.");

    worker.emit({ protocol: 1, type: "complete", jobId: "stale-job", result: null });
    emitFinalizing(worker, run.message.jobId);
    const firstResult = scannedResult();
    worker.emit({
      protocol: 1,
      type: "complete",
      jobId: run.message.jobId,
      result: firstResult,
    });
    worker.emit({
      protocol: 1,
      type: "failed",
      jobId: run.message.jobId,
      error: { code: "WORKER_CRASH", message: "late", retryable: true },
    });
    const unreadableLateEvent = Object.defineProperty({}, "data", {
      get(): never {
        throw new Error("settled handlers must not inspect data");
      },
    });
    expect(() => worker.onmessage?.(unreadableLateEvent as MessageEvent<unknown>)).not.toThrow();

    await expect(handle.result).resolves.toEqual({ status: "fulfilled", value: firstResult });
    expect(worker.terminateCount).toBe(1);
  });

  it("survives progress observer exceptions and still fulfills", async () => {
    installSupportedRuntime();
    const { file } = fakePdfFile();
    const handle = runPdfCompressScannedJob(file, balancedSpec, {
      expectedPageCount: 1,
      onProgress() {
        throw new Error("observer failed");
      },
    });
    const worker = latestWorker();
    const run = await waitForRun(worker);
    if (!isMessageType(run.message, "run")) throw new Error("Expected a run request.");
    emitFinalizing(worker, run.message.jobId);
    const value = scannedResult();
    worker.emit({ protocol: 1, type: "complete", jobId: run.message.jobId, result: value });

    await expect(handle.result).resolves.toEqual({ status: "fulfilled", value });
  });
});
