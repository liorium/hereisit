import type { PdfWorkerEvent, PdfWorkerRequest } from "@hereisit/tool-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectPdfFile } from "./run-pdf-inspection-job";

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

function installWorker(): void {
  vi.stubGlobal("Worker", SilentWorker);
  vi.stubGlobal("File", class {});
}

afterEach(() => {
  vi.unstubAllGlobals();
  SilentWorker.latest = undefined;
});

describe("inspectPdfFile direct module boundary", () => {
  it("posts the File after Worker readiness without reading it on the UI thread", async () => {
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
    await vi.waitFor(() =>
      expect(worker.messages.some((message) => message.type === "inspect")).toBe(true),
    );
    expect(arrayBuffer).not.toHaveBeenCalled();
    const request = worker.messages.find((message) => message.type === "inspect");
    expect(request).toMatchObject({
      type: "inspect",
      input: {
        name: "report.pdf",
        mimeHint: "application/pdf",
        byteLength: 1,
        file: expect.anything(),
      },
    });

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
    expect(worker.terminateCount).toBe(1);

    worker.emit({
      protocol: 1,
      type: "failed",
      jobId: request?.jobId ?? "missing",
      error: { code: "CORRUPT_PDF", message: "late failure", retryable: false },
    });
    expect(worker.terminateCount).toBe(1);
  });

  it("cancels before readiness without reading and settles once", async () => {
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
    expect(worker.terminateCount).toBe(1);
  });
});
