import type {
  PdfPipelineResult,
  PdfPipelineSpecV1,
  PdfWorkerEvent,
  PdfWorkerRequest,
} from "@hereisit/tool-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectPdfFile, runPdfJob } from "./run-pdf-job";

const watermarkSpec: PdfPipelineSpecV1 = {
  version: 1,
  operation: "watermark",
  watermark: {
    text: "대외비",
    placement: "center",
    fontSize: 48,
    opacity: 0.18,
    rotation: -45,
    color: "#334155",
  },
  selection: { mode: "every-page" },
};

const mergeSpec: PdfPipelineSpecV1 = { version: 1, operation: "merge" };
const splitSpec: PdfPipelineSpecV1 = {
  version: 1,
  operation: "split",
  selection: { mode: "every-page" },
};
const imagesToPdfSpec: PdfPipelineSpecV1 = {
  version: 1,
  operation: "images-to-pdf",
  page: { size: "a4", margin: 24 },
};

function fakePdfFile(read: Promise<ArrayBuffer> = Promise.resolve(Uint8Array.of(1).buffer)): File {
  return {
    name: "report.pdf",
    type: "application/pdf",
    size: 1,
    arrayBuffer: () => read,
  } as File;
}

function fakeImageFile(): File {
  return {
    name: "photo.png",
    type: "image/png",
    size: 1,
    arrayBuffer: () => Promise.resolve(Uint8Array.of(1).buffer),
  } as File;
}

function pdfResult(suggestedName = "result.pdf"): PdfPipelineResult {
  return {
    bytes: new ArrayBuffer(1),
    suggestedName,
    mime: "application/pdf",
    byteLength: 1,
    sourcePageCount: 1,
    outputPageCount: 1,
    outputDocumentCount: 1,
    warnings: [],
    timing: { loadMs: 0, processMs: 0, saveMs: 0, totalMs: 0 },
  };
}

function inspectionResult() {
  return {
    pageCount: 1,
    pages: [{ sourcePage: 1, width: 72, height: 72, rotation: 0 }],
  };
}

class SilentWorker {
  static latest: SilentWorker | undefined;
  readonly messages: PdfWorkerRequest[] = [];
  terminateCount = 0;
  onmessage: ((event: MessageEvent<PdfWorkerEvent>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;

  constructor() {
    SilentWorker.latest = this;
  }

  postMessage(message: PdfWorkerRequest): void {
    this.messages.push(message);
  }

  terminate(): void {
    this.terminateCount += 1;
  }

  emit(event: PdfWorkerEvent): void {
    this.onmessage?.({ data: event } as MessageEvent<PdfWorkerEvent>);
  }
}

function installWorker(worker: typeof SilentWorker = SilentWorker): void {
  vi.stubGlobal("Worker", worker);
  vi.stubGlobal("File", class {});
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  SilentWorker.latest = undefined;
});

describe("runPdfJob", () => {
  it.each([
    { name: "merge", files: [fakePdfFile(), fakePdfFile()], spec: mergeSpec, tool: "pdf.merge" },
    { name: "split", files: [fakePdfFile()], spec: splitSpec, tool: "pdf.split" },
    {
      name: "images-to-pdf",
      files: [fakeImageFile(), fakeImageFile()],
      spec: imagesToPdfSpec,
      tool: "pdf.images-to-pdf",
    },
  ])("posts $name files to the Worker without reading them on the main thread", async (testCase) => {
    installWorker();
    const reads = testCase.files.map((file) => vi.spyOn(file, "arrayBuffer"));
    const handle = runPdfJob(testCase.files, testCase.spec);
    const worker = SilentWorker.latest as SilentWorker;

    try {
      await vi.waitFor(() =>
        expect(
          worker.messages.some((message) => (message as { type: string }).type === "run-files"),
        ).toBe(true),
      );
      expect(reads.every((read) => read.mock.calls.length === 0)).toBe(true);
      const request = worker.messages.find(
        (message) => (message as { type: string }).type === "run-files",
      ) as unknown as {
        tool: string;
        inputs: readonly { file: File }[];
      };
      expect(request.tool).toBe(testCase.tool);
      expect(request.inputs.map((input) => input.file)).toEqual(testCase.files);
    } finally {
      handle.cancel();
    }
  });

  it("cancels after posting a run and ignores later Worker events", async () => {
    installWorker();
    const onProgress = vi.fn();
    const handle = runPdfJob([fakePdfFile()], watermarkSpec, { onProgress });
    const worker = SilentWorker.latest as SilentWorker;

    await vi.waitFor(() =>
      expect(worker.messages.some((message) => message.type === "run")).toBe(true),
    );
    const run = worker.messages.find((message) => message.type === "run");
    expect(run).toBeDefined();
    handle.cancel();
    await expect(handle.result).resolves.toEqual({ status: "cancelled" });
    const cancel = worker.messages.find((message) => message.type === "cancel");
    expect(cancel).toBeDefined();

    worker.emit({
      protocol: 1,
      type: "progress",
      jobId: run?.jobId ?? "missing",
      sequence: 1,
      phase: "processing",
      fraction: 0.5,
    });
    worker.emit({
      protocol: 1,
      type: "complete",
      jobId: run?.jobId ?? "missing",
      result: pdfResult("late.pdf"),
    });

    expect(onProgress).not.toHaveBeenCalled();
    expect(worker.terminateCount).toBe(1);
  });

  it("cancels before file reading completes without posting a run request", async () => {
    installWorker();
    let release: (bytes: ArrayBuffer) => void = () => undefined;
    const read = new Promise<ArrayBuffer>((resolve) => {
      release = resolve;
    });
    const handle = runPdfJob([fakePdfFile(read)], watermarkSpec);
    const worker = SilentWorker.latest as SilentWorker;

    handle.cancel();
    release(Uint8Array.of(1).buffer);
    await Promise.resolve();
    await Promise.resolve();

    await expect(handle.result).resolves.toEqual({ status: "cancelled" });
    expect(worker.messages.some((message) => message.type === "run")).toBe(false);
    expect(worker.terminateCount).toBe(1);
  });

  it("ignores later progress and completion after fulfillment", async () => {
    installWorker();
    const onProgress = vi.fn();
    const handle = runPdfJob([fakePdfFile()], watermarkSpec, { onProgress });
    const worker = SilentWorker.latest as SilentWorker;

    await vi.waitFor(() =>
      expect(worker.messages.some((message) => message.type === "run")).toBe(true),
    );
    const run = worker.messages.find((message) => message.type === "run");
    expect(run).toBeDefined();
    worker.emit({
      protocol: 1,
      type: "complete",
      jobId: run?.jobId ?? "missing",
      result: pdfResult("first.pdf"),
    });
    await expect(handle.result).resolves.toMatchObject({
      status: "fulfilled",
      value: { suggestedName: "first.pdf" },
    });

    worker.emit({
      protocol: 1,
      type: "progress",
      jobId: run?.jobId ?? "missing",
      sequence: 2,
      phase: "finalizing",
      fraction: 1,
    });
    worker.emit({
      protocol: 1,
      type: "complete",
      jobId: run?.jobId ?? "missing",
      result: pdfResult("late.pdf"),
    });

    expect(onProgress).not.toHaveBeenCalled();
    expect(worker.terminateCount).toBe(1);
  });

  it("settles the three-minute watchdog and terminates once", async () => {
    vi.useFakeTimers();
    installWorker();
    const handle = runPdfJob([fakePdfFile()], watermarkSpec);
    const worker = SilentWorker.latest as SilentWorker;

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(180_000);

    await expect(handle.result).resolves.toMatchObject({
      status: "rejected",
      error: { code: "WORKER_CRASH", retryable: true },
    });
    expect(worker.terminateCount).toBe(1);
  });

  it("turns synchronous Worker construction failure into a rejected outcome", async () => {
    class ThrowingWorker extends SilentWorker {
      constructor() {
        super();
        throw new DOMException("blocked", "SecurityError");
      }
    }
    installWorker(ThrowingWorker);

    const handle = runPdfJob([fakePdfFile()], watermarkSpec);

    await expect(handle.result).resolves.toMatchObject({
      status: "rejected",
      error: { code: "WORKER_CRASH", retryable: true },
    });
  });
});

describe("inspectPdfFile", () => {
  it("waits for inspection Worker readiness before reading the file", async () => {
    installWorker();
    const arrayBuffer = vi.fn(async () => Uint8Array.of(1).buffer);
    const handle = inspectPdfFile({
      name: "report.pdf",
      type: "application/pdf",
      size: 1,
      arrayBuffer,
    } as unknown as File);
    const worker = SilentWorker.latest as SilentWorker;

    await Promise.resolve();
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(worker.messages).toEqual([]);

    worker.emit({
      protocol: 1,
      type: "ready",
      capabilities: {
        operations: [
          "pdf.merge",
          "pdf.split",
          "pdf.images-to-pdf",
          "pdf.organize",
          "pdf.watermark",
        ],
      },
    });
    await vi.waitFor(() => expect(arrayBuffer).toHaveBeenCalledOnce());
    const request = worker.messages.find((message) => message.type === "inspect");
    expect(request).toBeDefined();

    worker.emit({
      protocol: 1,
      type: "inspected",
      jobId: request?.jobId ?? "missing",
      result: inspectionResult(),
    });
    await expect(handle.result).resolves.toEqual({
      status: "fulfilled",
      value: inspectionResult(),
    });
  });

  it("cancels inspection before readiness without reading the file", async () => {
    installWorker();
    const arrayBuffer = vi.fn(async () => Uint8Array.of(1).buffer);
    const handle = inspectPdfFile({
      name: "report.pdf",
      type: "application/pdf",
      size: 1,
      arrayBuffer,
    } as unknown as File);
    const worker = SilentWorker.latest as SilentWorker;

    handle.cancel();
    worker.emit({
      protocol: 1,
      type: "ready",
      capabilities: {
        operations: [
          "pdf.merge",
          "pdf.split",
          "pdf.images-to-pdf",
          "pdf.organize",
          "pdf.watermark",
        ],
      },
    });

    await expect(handle.result).resolves.toEqual({ status: "cancelled" });
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
});
