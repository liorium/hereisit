import type {
  PdfToImagesProgress,
  PdfToImagesResult,
  PdfToImagesSpecV1,
  PdfToImagesWorkerEvent,
} from "@hereisit/tool-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPdfToImagesJob, supportsBrowserPdfToImagesRuntime } from "./run-pdf-to-images-job";

const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 100 * 1024 * 1024;

const pdfToImagesSpec: PdfToImagesSpecV1 = {
  version: 1,
  selection: { mode: "every-page" },
  output: { format: "jpeg", quality: 85, background: "#ffffff" },
  dpi: 150,
};

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

interface FakeFileOptions {
  size?: number;
  read?: Promise<ArrayBuffer>;
}

function fakePdfFile(options: FakeFileOptions = {}): {
  file: File;
  arrayBuffer: ReturnType<typeof vi.fn>;
} {
  const size = options.size ?? 1;
  const read = options.read ?? Promise.resolve(new ArrayBuffer(size > MAX_PDF_BYTES ? 1 : size));
  const arrayBuffer = vi.fn(() => read);
  return {
    file: {
      name: "report.pdf",
      type: "application/pdf",
      size,
      arrayBuffer,
    } as unknown as File,
    arrayBuffer,
  };
}

function pdfToImagesResult(bytes = Uint8Array.of(0xff, 0xd8, 0xff).buffer): PdfToImagesResult {
  return {
    bytes,
    suggestedName: "report-page-001.jpg",
    mime: "image/jpeg",
    byteLength: bytes.byteLength,
    sourcePageCount: 1,
    outputPageCount: 1,
    outputFileCount: 1,
    format: "jpeg",
    warnings: ["PDF_PAGE_RASTERIZED", "COLOR_PROFILE_NORMALIZED"],
    timing: { loadMs: 1, renderMs: 2, encodeMs: 3, archiveMs: 0, totalMs: 6 },
  };
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

async function waitForRun(worker: StubWorker): Promise<PostedMessage> {
  if (!worker.messages.some(({ message }) => isMessageType(message, "run-file"))) {
    worker.emit({
      protocol: 1,
      type: "ready",
      capabilities: { offscreenCanvas: true, formats: ["jpeg", "png"] },
    });
  }
  await vi.waitFor(() => {
    expect(worker.messages.some(({ message }) => isMessageType(message, "run-file"))).toBe(true);
  });
  const posted = worker.messages.find(({ message }) => isMessageType(message, "run-file"));
  if (posted === undefined) throw new Error("Expected a run request.");
  return posted;
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

function progressEvent(
  jobId: string,
  sequence: number,
  progress: PdfToImagesProgress = { phase: "loading", fraction: 0.05 },
): PdfToImagesWorkerEvent {
  return {
    protocol: 1,
    type: "progress",
    jobId,
    sequence,
    ...progress,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  StubWorker.instances = [];
  SupportedOffscreenCanvas.instances = [];
});

describe("supportsBrowserPdfToImagesRuntime", () => {
  it.each([
    "Worker",
    "File",
    "OffscreenCanvas",
  ] as const)("requires the %s browser primitive", (primitive) => {
    installSupportedRuntime();
    vi.stubGlobal(primitive, undefined);

    expect(supportsBrowserPdfToImagesRuntime()).toBe(false);
  });

  it("requires a non-null 2D context", () => {
    installSupportedRuntime();
    vi.stubGlobal(
      "OffscreenCanvas",
      class extends SupportedOffscreenCanvas {
        override getContext(): null {
          return null;
        }
      },
    );

    expect(supportsBrowserPdfToImagesRuntime()).toBe(false);
  });

  it("requires convertToBlob and releases the 1x1 support canvas", () => {
    installSupportedRuntime();
    expect(supportsBrowserPdfToImagesRuntime()).toBe(true);
    expect(SupportedOffscreenCanvas.instances).toHaveLength(1);
    expect(SupportedOffscreenCanvas.instances[0]).toMatchObject({ width: 0, height: 0 });

    class MissingConvertCanvas {
      constructor(
        public width: number,
        public height: number,
      ) {}

      getContext(): object {
        return {};
      }
    }
    vi.stubGlobal("OffscreenCanvas", MissingConvertCanvas);
    expect(supportsBrowserPdfToImagesRuntime()).toBe(false);
  });

  it("returns false and still releases a canvas when probing throws", () => {
    let canvas: SupportedOffscreenCanvas | undefined;
    installSupportedRuntime();
    vi.stubGlobal(
      "OffscreenCanvas",
      class extends SupportedOffscreenCanvas {
        constructor(width: number, height: number) {
          super(width, height);
          canvas = this;
        }

        override getContext(): never {
          throw new Error("blocked");
        }
      },
    );

    expect(supportsBrowserPdfToImagesRuntime()).toBe(false);
    expect(canvas).toMatchObject({ width: 0, height: 0 });
  });
});

describe("runPdfToImagesJob", () => {
  it("rejects an unsupported runtime before constructing a Worker or reading the file", async () => {
    installSupportedRuntime();
    vi.stubGlobal("OffscreenCanvas", undefined);
    const { file, arrayBuffer } = fakePdfFile();

    const handle = runPdfToImagesJob(file, pdfToImagesSpec);

    await expect(handle.result).resolves.toEqual({
      status: "rejected",
      error: {
        code: "WORKER_CRASH",
        message: "이 브라우저는 로컬 PDF 이미지 변환을 지원하지 않아요.",
        retryable: false,
      },
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

    const handle = runPdfToImagesJob(file, pdfToImagesSpec);

    await expect(handle.result).resolves.toMatchObject({
      status: "rejected",
      error: { code: "MEMORY_LIMIT", retryable: false },
    });
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(StubWorker.instances).toHaveLength(0);
  });

  it("publishes validating synchronously, waits for Worker readiness, and posts the File unread", async () => {
    installSupportedRuntime();
    const { file, arrayBuffer } = fakePdfFile();
    const onProgress = vi.fn();

    runPdfToImagesJob(file, pdfToImagesSpec, { onProgress });

    expect(onProgress).toHaveBeenCalledOnce();
    expect(onProgress).toHaveBeenCalledWith({ phase: "validating", fraction: 0 });
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(latestWorker().messages).toHaveLength(0);

    latestWorker().emit({
      protocol: 1,
      type: "ready",
      capabilities: { offscreenCanvas: true, formats: ["jpeg", "png"] },
    });
    const run = await waitForRun(latestWorker());
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(run.transfer).toEqual([]);
    expect(run.message).toMatchObject({
      type: "run-file",
      input: { name: file.name, mimeHint: file.type, byteLength: file.size, file },
    });
  });

  it("rejects unsupported Worker capabilities before reading the file", async () => {
    installSupportedRuntime();
    const { file, arrayBuffer } = fakePdfFile();
    const handle = runPdfToImagesJob(file, pdfToImagesSpec);
    const worker = latestWorker();

    worker.emit({
      protocol: 1,
      type: "ready",
      capabilities: { offscreenCanvas: false, formats: ["jpeg", "png"] },
    });

    await expect(handle.result).resolves.toEqual({
      status: "rejected",
      error: {
        code: "WORKER_CRASH",
        message: "이 브라우저는 로컬 PDF 이미지 변환을 지원하지 않아요.",
        retryable: false,
      },
    });
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(worker.terminateCount).toBe(1);
  });

  it("turns a synchronous Worker construction error into one retryable rejection", async () => {
    class ThrowingWorker extends StubWorker {
      constructor(url: URL, options?: WorkerOptions) {
        super(url, options);
        throw new DOMException("blocked", "SecurityError");
      }
    }
    installSupportedRuntime(ThrowingWorker);
    const { file, arrayBuffer } = fakePdfFile();
    const observer = vi.fn();

    const handle = runPdfToImagesJob(file, pdfToImagesSpec);
    void handle.result.then(observer);

    await expect(handle.result).resolves.toMatchObject({
      status: "rejected",
      error: { code: "WORKER_CRASH", retryable: true },
    });
    await Promise.resolve();
    expect(observer).toHaveBeenCalledOnce();
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("settles once on message decoding failure and ignores later failures and completion", async () => {
    installSupportedRuntime();
    const { file } = fakePdfFile();
    const handle = runPdfToImagesJob(file, pdfToImagesSpec);
    const worker = latestWorker();
    const run = await waitForRun(worker);

    worker.onmessageerror?.({ data: undefined } as MessageEvent<unknown>);
    worker.onerror?.(new Error("late crash"));
    worker.emit({
      protocol: 1,
      type: "complete",
      jobId: isMessageType(run.message, "run-file") ? run.message.jobId : "missing",
      result: pdfToImagesResult(),
    });

    await expect(handle.result).resolves.toMatchObject({
      status: "rejected",
      error: { code: "WORKER_CRASH", retryable: true },
    });
    expect(worker.terminateCount).toBe(1);
  });

  it("cancels before Worker readiness without posting a run request", async () => {
    installSupportedRuntime();
    const { file, arrayBuffer } = fakePdfFile();
    const handle = runPdfToImagesJob(file, pdfToImagesSpec);
    const worker = latestWorker();

    handle.cancel();

    await expect(handle.result).resolves.toEqual({ status: "cancelled" });
    expect(worker.messages.some(({ message }) => isMessageType(message, "run-file"))).toBe(false);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(worker.terminateCount).toBe(1);
  });

  it("cancels after posting exactly once, terminates once, and ignores late events", async () => {
    installSupportedRuntime();
    const { file } = fakePdfFile();
    const onProgress = vi.fn();
    const handle = runPdfToImagesJob(file, pdfToImagesSpec, { onProgress });
    const worker = latestWorker();
    const run = await waitForRun(worker);
    if (!isMessageType(run.message, "run-file")) throw new Error("Expected a run request.");

    handle.cancel();
    handle.cancel();
    worker.emit(progressEvent(run.message.jobId, 0));
    worker.emit({
      protocol: 1,
      type: "complete",
      jobId: run.message.jobId,
      result: pdfToImagesResult(),
    });

    await expect(handle.result).resolves.toEqual({ status: "cancelled" });
    expect(worker.messages.filter(({ message }) => isMessageType(message, "cancel"))).toHaveLength(
      1,
    );
    expect(worker.terminateCount).toBe(1);
    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  it("settles the 180-second watchdog from handle creation and terminates once", async () => {
    vi.useFakeTimers();
    installSupportedRuntime();
    const { file } = fakePdfFile({ read: new Promise<ArrayBuffer>(() => undefined) });

    const handle = runPdfToImagesJob(file, pdfToImagesSpec);
    const worker = latestWorker();
    const observer = vi.fn();
    void handle.result.then(observer);

    await vi.advanceTimersByTimeAsync(179_999);
    expect(observer).not.toHaveBeenCalled();
    expect(worker.terminateCount).toBe(0);

    await vi.advanceTimersByTimeAsync(1);

    await expect(handle.result).resolves.toMatchObject({
      status: "rejected",
      error: { code: "WORKER_CRASH", retryable: true },
    });
    expect(worker.terminateCount).toBe(1);
  });

  it("ignores malformed, wrong-protocol, wrong-job, and stale progress events", async () => {
    installSupportedRuntime();
    const { file } = fakePdfFile();
    const onProgress = vi.fn();
    const handle = runPdfToImagesJob(file, pdfToImagesSpec, { onProgress });
    const worker = latestWorker();
    const run = await waitForRun(worker);
    if (!isMessageType(run.message, "run-file")) throw new Error("Expected a run request.");

    worker.emit(null);
    worker.emit({ protocol: 2, type: "progress", jobId: run.message.jobId, sequence: 9 });
    worker.emit(progressEvent("another-job", 10));
    worker.emit(
      progressEvent(run.message.jobId, 1, {
        phase: "rendering",
        fraction: 0.2,
        completedPages: 1,
        totalPages: 101,
      }),
    );
    worker.emit(progressEvent(run.message.jobId, 3, { phase: "loading", fraction: 0.3 }));
    worker.emit(progressEvent(run.message.jobId, 2, { phase: "loading", fraction: 0.2 }));
    worker.emit(progressEvent(run.message.jobId, 3, { phase: "loading", fraction: 0.4 }));
    worker.emit({
      protocol: 1,
      type: "complete",
      jobId: run.message.jobId,
      result: pdfToImagesResult(),
    });

    await expect(handle.result).resolves.toMatchObject({ status: "fulfilled" });
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenLastCalledWith({ phase: "loading", fraction: 0.3 });
  });

  it("strips unknown fields from progress before notifying the public callback", async () => {
    installSupportedRuntime();
    const { file } = fakePdfFile();
    const onProgress = vi.fn();
    const handle = runPdfToImagesJob(file, pdfToImagesSpec, { onProgress });
    const worker = latestWorker();
    const run = await waitForRun(worker);
    if (!isMessageType(run.message, "run-file")) throw new Error("Expected a run request.");

    worker.emit({
      ...progressEvent(run.message.jobId, 0),
      source: "/Users/private/report.pdf",
      raw: { detail: "secret" },
    });

    expect(onProgress).toHaveBeenLastCalledWith({ phase: "loading", fraction: 0.05 });
    expect(JSON.stringify(onProgress.mock.calls.at(-1))).not.toContain("private");
    handle.cancel();
    await expect(handle.result).resolves.toEqual({ status: "cancelled" });
  });

  it("strips unknown fields from a failed outcome", async () => {
    installSupportedRuntime();
    const { file } = fakePdfFile();
    const handle = runPdfToImagesJob(file, pdfToImagesSpec);
    const worker = latestWorker();
    const run = await waitForRun(worker);
    if (!isMessageType(run.message, "run-file")) throw new Error("Expected a run request.");

    worker.emit({
      protocol: 1,
      type: "failed",
      jobId: run.message.jobId,
      error: {
        code: "WORKER_CRASH",
        message: "safe",
        retryable: true,
        source: "/Users/private/report.pdf",
        raw: { detail: "secret" },
      },
    });

    const outcome = await handle.result;
    expect(outcome).toEqual({
      status: "rejected",
      error: { code: "WORKER_CRASH", message: "safe", retryable: true },
    });
    expect(JSON.stringify(outcome)).not.toContain("private");
    expect(JSON.stringify(outcome)).not.toContain("secret");
  });

  it("strips unknown top-level and timing fields from a complete outcome", async () => {
    installSupportedRuntime();
    const { file } = fakePdfFile();
    const handle = runPdfToImagesJob(file, pdfToImagesSpec);
    const worker = latestWorker();
    const run = await waitForRun(worker);
    if (!isMessageType(run.message, "run-file")) throw new Error("Expected a run request.");
    const cleanResult = pdfToImagesResult();

    worker.emit({
      protocol: 1,
      type: "complete",
      jobId: run.message.jobId,
      result: {
        ...cleanResult,
        source: "/Users/private/report.pdf",
        timing: { ...cleanResult.timing, raw: "secret" },
      },
    });

    const outcome = await handle.result;
    expect(outcome).toEqual({ status: "fulfilled", value: cleanResult });
    expect(JSON.stringify(outcome)).not.toContain("private");
    expect(JSON.stringify(outcome)).not.toContain("secret");
  });

  it("ignores a complete result whose MIME is a boxed string", async () => {
    installSupportedRuntime();
    const { file } = fakePdfFile();
    const handle = runPdfToImagesJob(file, pdfToImagesSpec);
    const worker = latestWorker();
    const run = await waitForRun(worker);
    if (!isMessageType(run.message, "run-file")) throw new Error("Expected a run request.");
    const cleanResult = pdfToImagesResult();

    worker.emit({
      protocol: 1,
      type: "complete",
      jobId: run.message.jobId,
      result: {
        ...cleanResult,
        mime: Object.assign(new String("image/jpeg"), {
          source: "/Users/private/report.pdf",
        }),
      },
    });
    worker.emit({
      protocol: 1,
      type: "complete",
      jobId: run.message.jobId,
      result: cleanResult,
    });

    await expect(handle.result).resolves.toEqual({ status: "fulfilled", value: cleanResult });
  });

  it.each([
    {
      name: "empty bytes",
      mutate: (result: PdfToImagesResult) => ({
        ...result,
        bytes: new ArrayBuffer(0),
        byteLength: 0,
      }),
    },
    {
      name: "oversized bytes",
      mutate: (result: PdfToImagesResult) => {
        const bytes = new ArrayBuffer(3);
        Object.defineProperty(bytes, "byteLength", { value: MAX_OUTPUT_BYTES + 1 });
        return { ...result, bytes, byteLength: bytes.byteLength };
      },
    },
    {
      name: "non-JPEG payload",
      mutate: (result: PdfToImagesResult) => {
        const bytes = new TextEncoder().encode("<html>not an image</html>").buffer;
        return { ...result, bytes, byteLength: bytes.byteLength };
      },
    },
    {
      name: "source count above the contract limit",
      mutate: (result: PdfToImagesResult) => ({ ...result, sourcePageCount: 501 }),
    },
    {
      name: "inconsistent output counts",
      mutate: (result: PdfToImagesResult) => ({ ...result, outputFileCount: 2 }),
    },
    {
      name: "direct MIME and format mismatch",
      mutate: (result: PdfToImagesResult) => ({ ...result, mime: "image/png" as const }),
    },
    {
      name: "unsafe download name",
      mutate: (result: PdfToImagesResult) => ({
        ...result,
        suggestedName: "../report\u202egpj.jpg",
      }),
    },
  ])("ignores a complete result with $name", async ({ mutate }) => {
    installSupportedRuntime();
    const { file } = fakePdfFile();
    const handle = runPdfToImagesJob(file, pdfToImagesSpec);
    const worker = latestWorker();
    const run = await waitForRun(worker);
    if (!isMessageType(run.message, "run-file")) throw new Error("Expected a run request.");
    const cleanResult = pdfToImagesResult();

    worker.emit({
      protocol: 1,
      type: "complete",
      jobId: run.message.jobId,
      result: mutate(cleanResult),
    });
    worker.emit({
      protocol: 1,
      type: "complete",
      jobId: run.message.jobId,
      result: cleanResult,
    });

    await expect(handle.result).resolves.toEqual({ status: "fulfilled", value: cleanResult });
  });

  it("ignores a failed event with control or bidi characters in its public message", async () => {
    installSupportedRuntime();
    const { file } = fakePdfFile();
    const handle = runPdfToImagesJob(file, pdfToImagesSpec);
    const worker = latestWorker();
    const run = await waitForRun(worker);
    if (!isMessageType(run.message, "run-file")) throw new Error("Expected a run request.");
    const cleanResult = pdfToImagesResult();

    worker.emit({
      protocol: 1,
      type: "failed",
      jobId: run.message.jobId,
      error: {
        code: "WORKER_CRASH",
        message: "unsafe\n/Users/private/report.pdf\u202e",
        retryable: true,
      },
    });
    worker.emit({
      protocol: 1,
      type: "complete",
      jobId: run.message.jobId,
      result: cleanResult,
    });

    await expect(handle.result).resolves.toEqual({ status: "fulfilled", value: cleanResult });
  });

  it("ignores a stale complete and duplicate terminals without inspecting events after settlement", async () => {
    installSupportedRuntime();
    const { file } = fakePdfFile();
    const handle = runPdfToImagesJob(file, pdfToImagesSpec);
    const worker = latestWorker();
    const run = await waitForRun(worker);
    if (!isMessageType(run.message, "run-file")) throw new Error("Expected a run request.");
    const firstResult = pdfToImagesResult();

    worker.emit({
      protocol: 1,
      type: "complete",
      jobId: "stale-job",
      result: pdfToImagesResult(new ArrayBuffer(9)),
    });
    worker.emit({ protocol: 1, type: "complete", jobId: run.message.jobId, result: firstResult });
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

  it("survives progress callback exceptions and still fulfills", async () => {
    installSupportedRuntime();
    const { file } = fakePdfFile();
    const handle = runPdfToImagesJob(file, pdfToImagesSpec, {
      onProgress() {
        throw new Error("observer failure");
      },
    });
    const worker = latestWorker();
    const run = await waitForRun(worker);
    if (!isMessageType(run.message, "run-file")) throw new Error("Expected a run request.");
    const result = pdfToImagesResult();

    worker.emit(progressEvent(run.message.jobId, 0));
    worker.emit({ protocol: 1, type: "complete", jobId: run.message.jobId, result });

    await expect(handle.result).resolves.toEqual({ status: "fulfilled", value: result });
  });

  it("posts the exact module Worker request with the unread File", async () => {
    installSupportedRuntime();
    const bytes = Uint8Array.of(1, 2, 3).buffer;
    const { file } = fakePdfFile({ size: bytes.byteLength, read: Promise.resolve(bytes) });

    runPdfToImagesJob(file, pdfToImagesSpec);
    const worker = latestWorker();
    const run = await waitForRun(worker);

    expect(worker.url.pathname).toMatch(/\/pdf-to-images\.worker\.ts$/);
    expect(worker.options).toEqual({
      type: "module",
      name: "hereisit-pdf-to-images-worker",
    });
    expect(run.transfer).toEqual([]);
    expect(run.message).toMatchObject({
      protocol: 1,
      type: "run-file",
      tool: "pdf.to-images",
      toolVersion: 1,
      input: {
        name: "report.pdf",
        mimeHint: "application/pdf",
        byteLength: bytes.byteLength,
        file,
      },
      spec: pdfToImagesSpec,
    });
  });

  it("maps a run postMessage exception to one retryable Worker failure", async () => {
    class ThrowingPostWorker extends StubWorker {
      override postMessage(message: unknown, transfer: readonly Transferable[] = []): void {
        super.postMessage(message, transfer);
        if (isMessageType(message, "run-file")) {
          throw new DOMException("detached", "DataCloneError");
        }
      }
    }
    installSupportedRuntime(ThrowingPostWorker);
    const { file } = fakePdfFile();

    const handle = runPdfToImagesJob(file, pdfToImagesSpec);
    const worker = latestWorker();
    worker.emit({
      protocol: 1,
      type: "ready",
      capabilities: { offscreenCanvas: true, formats: ["jpeg", "png"] },
    });

    await expect(handle.result).resolves.toMatchObject({
      status: "rejected",
      error: { code: "WORKER_CRASH", retryable: true },
    });
    expect(worker.terminateCount).toBe(1);
  });
});
