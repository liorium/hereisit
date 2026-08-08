import type {
  PdfThumbnailProgress,
  PdfThumbnailResult,
  PdfThumbnailUpdate,
} from "@hereisit/tool-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPdfThumbnailJob, supportsBrowserPdfThumbnailRuntime } from "./run-pdf-thumbnail-job";

const WEBP_BYTES = Uint8Array.of(
  0x52,
  0x49,
  0x46,
  0x46,
  0x04,
  0,
  0,
  0,
  0x57,
  0x45,
  0x42,
  0x50,
).buffer;

class StubWorker {
  static instances: StubWorker[] = [];
  readonly messages: Array<{ message: unknown; transfer: readonly Transferable[] }> = [];
  terminateCount = 0;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;

  constructor(
    readonly url: URL,
    readonly options?: WorkerOptions,
  ) {
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

class SupportedCanvas {
  constructor(
    public width: number,
    public height: number,
  ) {}
  getContext(): object {
    return {};
  }
  async convertToBlob(): Promise<Blob> {
    return new Blob();
  }
}

function installRuntime(): void {
  vi.stubGlobal("Worker", StubWorker);
  vi.stubGlobal("File", class {});
  vi.stubGlobal("OffscreenCanvas", SupportedCanvas);
}

function fakeFile(read = WEBP_BYTES): File {
  return {
    name: "private.pdf",
    type: "application/pdf",
    size: read.byteLength,
    arrayBuffer: vi.fn(async () => read),
  } as unknown as File;
}

function latestWorker(): StubWorker {
  const worker = StubWorker.instances.at(-1);
  if (worker === undefined) throw new Error("Expected a Worker.");
  return worker;
}

function isMessageType(value: unknown, type: string): value is { type: string; jobId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === type &&
    "jobId" in value &&
    typeof value.jobId === "string"
  );
}

async function startRun(file = fakeFile()) {
  const handle = runPdfThumbnailJob(file);
  const worker = latestWorker();
  worker.emit({
    protocol: 1,
    type: "ready",
    capabilities: { tool: "pdf.thumbnail", toolVersion: 1 },
  });
  await vi.waitFor(() =>
    expect(worker.messages.some(({ message }) => isMessageType(message, "run"))).toBe(true),
  );
  const run = worker.messages.find(({ message }) => isMessageType(message, "run"));
  if (run === undefined || !isMessageType(run.message, "run")) throw new Error("Missing run.");
  return { handle, worker, jobId: run.message.jobId };
}

function thumbnailEvent(
  jobId: string,
  sourcePage: number,
  sequence = sourcePage - 1,
  overrides: Partial<Extract<PdfThumbnailUpdate, { status: "ready" }>> = {},
) {
  return {
    protocol: 1,
    type: "thumbnail",
    jobId,
    sequence,
    update: {
      status: "ready",
      sourcePage,
      width: 160,
      height: 80,
      mime: "image/webp",
      bytes: WEBP_BYTES,
      ...overrides,
    },
  };
}

function completeEvent(jobId: string, result: Partial<PdfThumbnailResult> = {}) {
  return {
    protocol: 1,
    type: "complete",
    jobId,
    result: {
      pageCount: 1,
      renderedPageCount: 1,
      failedPageCount: 0,
      omittedPageCount: 0,
      ...result,
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  StubWorker.instances = [];
});

describe("PDF thumbnail job boundary", () => {
  it("requires OffscreenCanvas APIs without allocating a support canvas", () => {
    installRuntime();
    expect(supportsBrowserPdfThumbnailRuntime()).toBe(true);
    const CanvasConstructor = vi.fn(() => {
      throw new Error("transient allocation failure");
    });
    CanvasConstructor.prototype = SupportedCanvas.prototype;
    vi.stubGlobal("OffscreenCanvas", CanvasConstructor);
    expect(supportsBrowserPdfThumbnailRuntime()).toBe(true);
    expect(CanvasConstructor).not.toHaveBeenCalled();
    vi.stubGlobal("OffscreenCanvas", class {});
    expect(supportsBrowserPdfThumbnailRuntime()).toBe(false);
    vi.stubGlobal("OffscreenCanvas", undefined);
    expect(supportsBrowserPdfThumbnailRuntime()).toBe(false);
  });

  it("waits for readiness, then posts the File without reading it on the UI thread", async () => {
    installRuntime();
    const file = fakeFile();
    const read = file.arrayBuffer as ReturnType<typeof vi.fn>;
    const handle = runPdfThumbnailJob(file);
    const worker = latestWorker();
    expect(read).not.toHaveBeenCalled();
    worker.emit({
      protocol: 1,
      type: "ready",
      capabilities: { tool: "pdf.thumbnail", toolVersion: 1 },
    });
    await vi.waitFor(() =>
      expect(worker.messages.some(({ message }) => isMessageType(message, "run"))).toBe(true),
    );
    expect(read).not.toHaveBeenCalled();
    const posted = worker.messages.find(({ message }) => isMessageType(message, "run"));
    expect(posted?.message).toMatchObject({ input: { file } });
    expect(posted?.transfer).toEqual([]);
    handle.cancel();
  });

  it("delivers only validated monotonic updates and strips unknown fields", async () => {
    installRuntime();
    const updates: PdfThumbnailUpdate[] = [];
    const progress: PdfThumbnailProgress[] = [];
    const handle = runPdfThumbnailJob(fakeFile(), {
      onThumbnail: (update) => updates.push(update),
      onProgress: (event) => progress.push(event),
    });
    const worker = latestWorker();
    worker.emit({
      protocol: 1,
      type: "ready",
      capabilities: { tool: "pdf.thumbnail", toolVersion: 1 },
    });
    await vi.waitFor(() =>
      expect(worker.messages.some(({ message }) => isMessageType(message, "run"))).toBe(true),
    );
    const run = worker.messages.find(({ message }) => isMessageType(message, "run"));
    if (run === undefined || !isMessageType(run.message, "run")) throw new Error("Missing run.");
    const jobId = run.message.jobId;

    worker.emit(thumbnailEvent("wrong-job", 1));
    worker.emit(thumbnailEvent(jobId, 1, 0, { width: 161 }));
    worker.emit(
      thumbnailEvent(jobId, 1, 0, { bytes: new TextEncoder().encode("not webp").buffer }),
    );
    worker.emit({ ...thumbnailEvent(jobId, 1), privateName: "secret.pdf" });
    worker.emit(thumbnailEvent(jobId, 1, 0));
    worker.emit({
      protocol: 1,
      type: "progress",
      jobId,
      sequence: 1,
      completedPages: 1,
      totalPages: 1,
      fraction: 1,
      privateName: "secret.pdf",
    });
    worker.emit(completeEvent(jobId));

    await expect(handle.result).resolves.toEqual({
      status: "fulfilled",
      value: { pageCount: 1, renderedPageCount: 1, failedPageCount: 0, omittedPageCount: 0 },
    });
    expect(updates).toEqual([
      {
        status: "ready",
        sourcePage: 1,
        width: 160,
        height: 80,
        mime: "image/webp",
        bytes: WEBP_BYTES,
      },
    ]);
    expect(progress).toEqual([{ completedPages: 1, totalPages: 1, fraction: 1 }]);
    expect(JSON.stringify({ updates, progress })).not.toContain("secret");
  });

  it("rejects completion counts that do not match accepted updates", async () => {
    installRuntime();
    const { handle, worker, jobId } = await startRun();
    worker.emit(thumbnailEvent(jobId, 1));
    worker.emit(completeEvent(jobId, { renderedPageCount: 0, failedPageCount: 1 }));
    worker.emit(completeEvent(jobId));
    await expect(handle.result).resolves.toMatchObject({ status: "fulfilled" });
  });

  it("drops a page that would exceed the aggregate byte budget", async () => {
    installRuntime();
    const bytes = new Uint8Array(160 * 160 * 4);
    bytes.set(new Uint8Array(WEBP_BYTES));
    let updates = 0;
    const handle = runPdfThumbnailJob(fakeFile(), {
      onThumbnail: () => {
        updates += 1;
      },
    });
    const worker = latestWorker();
    worker.emit({
      protocol: 1,
      type: "ready",
      capabilities: { tool: "pdf.thumbnail", toolVersion: 1 },
    });
    await vi.waitFor(() =>
      expect(worker.messages.some(({ message }) => isMessageType(message, "run"))).toBe(true),
    );
    const run = worker.messages.find(({ message }) => isMessageType(message, "run"));
    if (run === undefined || !isMessageType(run.message, "run")) throw new Error("Missing run.");

    for (let sourcePage = 1; sourcePage <= 492; sourcePage += 1) {
      worker.emit(
        thumbnailEvent(run.message.jobId, sourcePage, sourcePage - 1, {
          width: 160,
          height: 160,
          bytes: bytes.buffer,
        }),
      );
    }
    worker.emit(
      completeEvent(run.message.jobId, {
        pageCount: 500,
        renderedPageCount: 491,
        omittedPageCount: 9,
      }),
    );

    await expect(handle.result).resolves.toMatchObject({ status: "fulfilled" });
    expect(updates).toBe(491);
  });

  it("ignores hostile getters and observer exceptions", async () => {
    installRuntime();
    const onThumbnail = vi.fn(() => {
      throw new Error("observer failure");
    });
    const handle = runPdfThumbnailJob(fakeFile(), { onThumbnail });
    const worker = latestWorker();
    worker.emit(
      new Proxy(
        {},
        {
          get() {
            throw new Error("hostile getter");
          },
        },
      ),
    );
    worker.emit({
      protocol: 1,
      type: "ready",
      capabilities: { tool: "pdf.thumbnail", toolVersion: 1 },
    });
    await vi.waitFor(() =>
      expect(worker.messages.some(({ message }) => isMessageType(message, "run"))).toBe(true),
    );
    const run = worker.messages.find(({ message }) => isMessageType(message, "run"));
    if (run === undefined || !isMessageType(run.message, "run")) throw new Error("Missing run.");
    worker.emit(thumbnailEvent(run.message.jobId, 1));
    worker.emit(completeEvent(run.message.jobId));

    await expect(handle.result).resolves.toMatchObject({ status: "fulfilled" });
    expect(onThumbnail).toHaveBeenCalledOnce();
  });

  it("cancels once and ignores late output", async () => {
    installRuntime();
    const { handle, worker, jobId } = await startRun();
    handle.cancel();
    handle.cancel();
    worker.emit(thumbnailEvent(jobId, 1));
    worker.emit(completeEvent(jobId));

    await expect(handle.result).resolves.toEqual({ status: "cancelled" });
    expect(worker.messages.filter(({ message }) => isMessageType(message, "cancel"))).toHaveLength(
      1,
    );
    expect(worker.terminateCount).toBe(1);
  });

  it("settles the three-minute watchdog", async () => {
    vi.useFakeTimers();
    installRuntime();
    const handle = runPdfThumbnailJob(fakeFile(new ArrayBuffer(1)));
    const worker = latestWorker();
    await vi.advanceTimersByTimeAsync(180_000);

    await expect(handle.result).resolves.toMatchObject({
      status: "rejected",
      error: { code: "WORKER_CRASH", retryable: true },
    });
    expect(worker.terminateCount).toBe(1);
  });
});
