import type { PdfOptimizeResultDescriptor } from "@hereisit/tool-contracts/pdf-optimize";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyPdfOptimizeResult } from "./run-pdf-optimize-verification";

class StubWorker {
  static instances: StubWorker[] = [];
  readonly messages: unknown[] = [];
  terminateCount = 0;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  constructor(
    readonly url: URL,
    readonly options?: WorkerOptions,
  ) {
    StubWorker.instances.push(this);
  }
  postMessage(message: unknown): void {
    this.messages.push(message);
  }
  terminate(): void {
    this.terminateCount += 1;
  }
  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }
}

const descriptor: Extract<PdfOptimizeResultDescriptor, { kind: "download" }> = {
  kind: "download",
  mime: "application/pdf",
  sourceByteLength: 100,
  byteLength: 90,
  pageCount: 1,
  profile: "structural",
  engineBuildId: "sha256:engine",
  warnings: ["SIGNATURES_INVALIDATED"],
};

function file(size: number): { file: File; read: ReturnType<typeof vi.fn> } {
  const value = new File([new Uint8Array(size)], "private.pdf", { type: "application/pdf" });
  return { file: value, read: vi.spyOn(value, "arrayBuffer") };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  StubWorker.instances = [];
});

describe("verifyPdfOptimizeResult", () => {
  it("posts native Files with exact keys and never reads either File in the main realm", async () => {
    vi.stubGlobal("Worker", StubWorker);
    const source = file(100);
    const result = file(90);
    const handle = verifyPdfOptimizeResult(source.file, result.file, descriptor);
    const worker = StubWorker.instances[0];
    if (worker === undefined) throw new Error("worker");
    worker.emit({ protocol: 1, type: "ready" });
    await vi.waitFor(() => expect(worker.messages).toHaveLength(1));
    const request = worker.messages[0] as Record<string, unknown>;
    expect(Object.keys(request).sort()).toEqual([
      "descriptor",
      "jobId",
      "protocol",
      "result",
      "source",
      "type",
    ]);
    expect(request).toMatchObject({ type: "verify", source: source.file, result: result.file });
    expect(source.read).not.toHaveBeenCalled();
    expect(result.read).not.toHaveBeenCalled();
    const jobId = request.jobId;
    worker.emit({ protocol: 1, type: "complete", jobId, descriptor, blob: result.file });
    await expect(handle.result).resolves.toMatchObject({ status: "fulfilled" });
    expect(worker.terminateCount).toBe(1);
  });

  it("ignores late/wrong events, sanitizes failures, and cancels idempotently", async () => {
    vi.stubGlobal("Worker", StubWorker);
    const source = file(100);
    const result = file(90);
    const handle = verifyPdfOptimizeResult(source.file, result.file, descriptor);
    const worker = StubWorker.instances[0];
    if (worker === undefined) throw new Error("worker");
    worker.emit({ protocol: 1, type: "ready" });
    await vi.waitFor(() => expect(worker.messages).toHaveLength(1));
    worker.emit({ protocol: 1, type: "failed", jobId: "wrong", error: { message: "secret" } });
    handle.cancel();
    handle.cancel();
    const request = worker.messages[0] as { jobId: string };
    worker.emit({ protocol: 1, type: "cancelled", jobId: request.jobId });
    await expect(handle.result).resolves.toEqual({ status: "cancelled" });
    expect(worker.messages).toHaveLength(2);
    expect(worker.terminateCount).toBe(1);
  });

  it("times out, handles messageerror, and never exposes a private Worker error", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("Worker", StubWorker);
    const handle = verifyPdfOptimizeResult(file(100).file, file(90).file, descriptor, {
      timeoutMilliseconds: 10,
    });
    const worker = StubWorker.instances[0];
    if (worker === undefined) throw new Error("worker");
    await vi.advanceTimersByTimeAsync(10);
    const cancel = worker.messages.at(-1) as { jobId: string };
    expect(cancel).toMatchObject({ protocol: 1, type: "cancel" });
    worker.emit({ protocol: 1, type: "cancelled", jobId: cancel.jobId });
    await expect(handle.result).resolves.toEqual({
      status: "rejected",
      error: {
        code: "VERIFICATION_FAILED",
        message: "PDF 처리 결과를 확인할 수 없습니다.",
        retryable: true,
      },
    });
  });
});
